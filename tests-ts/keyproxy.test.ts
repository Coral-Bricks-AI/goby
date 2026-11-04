import {test, expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const proxyScript = resolve(import.meta.dir, '../base/keyproxy.mjs');

/** Start the real proxy against a stub upstream and resolve once it is answering. */
async function withProxy(
  handler: Parameters<typeof createServer>[1],
  run: (url: string, port: number) => Promise<void>,
) {
  const upstream = createServer(handler);
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), 'goby-proxy-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'REAL-SECRET-KEY\n');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn('node', [proxyScript], {
    env: { ...process.env, GOBY_PROXY_PORT: String(port), GOBY_KEY_FILE: keyFile,
      GOBY_UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/v1/models`);
        break;
      } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    child.kill();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the agent\'s dummy key is replaced with the real one', async () => {
  let seen: Record<string, unknown> = {};
  await withProxy((req, res) => {
    seen = { auth: req.headers.authorization, path: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, async url => {
    const res = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer dummy-proxy-key', 'content-type': 'application/json' },
      body: '{"model":"x"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    // Exactly one credential reaches the upstream, and it is the file's.
    expect(seen.auth).toBe('Bearer REAL-SECRET-KEY');
    expect(seen.path).toBe('/v1/responses');
  });
});

test('a body and a stream pass through untouched', async () => {
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 30);
  }, async url => {
    const res = await fetch(`${url}/v1/responses`, { method: 'POST', body: 'payload' });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: one\n\ndata: two\n\n');
  });
});

test('an upstream failure is a 502 the caller can see, not a hang', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goby-proxy-dead-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'k');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn('node', [proxyScript], {
    env: { ...process.env, GOBY_PROXY_PORT: String(port), GOBY_KEY_FILE: keyFile,
      GOBY_UPSTREAM: 'http://127.0.0.1:1' }, // nothing listens there
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise(r => setTimeout(r, 300));
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('keyproxy');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the proxy refuses to start without a key file', async () => {
  const child = spawn('node', [proxyScript], {
    env: { ...process.env, GOBY_PROXY_PORT: '19999', GOBY_KEY_FILE: '/nonexistent/key',
      GOBY_UPSTREAM: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise<number | null>(done => child.on('exit', done));
  expect(code).not.toBe(0);
});

test('an https upstream is spoken to with the https module', async () => {
  // `node:http`'s request() throws ERR_INVALID_PROTOCOL on a TLS upstream, which is what the first
  // dogfooded review hit: every model call became a connection error with a stack trace in the log.
  const dir = mkdtempSync(join(tmpdir(), 'goby-proxy-tls-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'k');
  const port = 19500 + Math.floor(Math.random() * 400);
  const child = spawn('node', [proxyScript], {
    env: { ...process.env, GOBY_PROXY_PORT: String(port), GOBY_KEY_FILE: keyFile,
      GOBY_UPSTREAM: 'https://127.0.0.1:1' }, // nothing listens over TLS there
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  try {
    await new Promise(r => setTimeout(r, 300));
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: 'POST', body: '{}' });
    // A refused connection is a 502 the caller can read, and never ERR_INVALID_PROTOCOL.
    expect(res.status).toBe(502);
    expect(stderr.join('')).not.toContain('ERR_INVALID_PROTOCOL');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
