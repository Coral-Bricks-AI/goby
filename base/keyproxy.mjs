/**
 * The model key proxy: the only thing in the container that knows the real key.
 *
 * A review has to let code from the pull request run — that is the point of cloning and giving
 * the agent a shell. The model key cannot be in that code's reach, and unlike the GitHub token
 * it cannot live in another uid either, because the agent's own process is what calls the model.
 *
 * So the agent is handed a dummy key and a base URL on loopback. This forwards to the real
 * upstream, replacing the authorization header with the key it reads from a root-only file. It
 * is a byte pass-through: no protocol awareness, no parsing, no buffering, so SSE streams and
 * the Responses API work unchanged.
 *
 * Deliberate omissions: it never logs a body (bodies are the reviewed repository's code), it
 * only listens on 127.0.0.1, and it exits non-zero if the key file or upstream is missing —
 * a proxy that half-works turns every review into a silent model error.
 */
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.GOBY_PROXY_PORT ?? 8787);
const UPSTREAM = process.env.GOBY_UPSTREAM ?? '';
const KEY_FILE = process.env.GOBY_KEY_FILE ?? '';
const KEY_HEADER = (process.env.GOBY_KEY_HEADER ?? 'authorization').toLowerCase();
const KEY_SCHEME = process.env.GOBY_KEY_SCHEME ?? 'Bearer ';

if (!UPSTREAM) throw new Error('GOBY_UPSTREAM is required');
if (!KEY_FILE) throw new Error('GOBY_KEY_FILE is required');

const upstream = new URL(UPSTREAM);
const key = readFileSync(KEY_FILE, 'utf8').trim();
if (!key) throw new Error(`${KEY_FILE} is empty`);

const server = createServer((req, res) => {
  const headers = { ...req.headers };
  // The agent's dummy authorization is replaced, not merged: forward exactly one credential.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === KEY_HEADER) delete headers[name];
  }
  headers[KEY_HEADER] = KEY_SCHEME + key;
  headers.host = upstream.host;

  const upstreamReq = request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: upstream.pathname.replace(/\/$/, '') + req.url,
    headers,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', error => {
    // The reason only — never the request line's body, and never the key.
    console.error(`keyproxy upstream error: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `keyproxy: ${error.message}` } }));
  });
  req.pipe(upstreamReq);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

server.listen(PORT, '127.0.0.1', () => {
  // Printed so the entrypoint can confirm it is serving, not merely spawned.
  console.log(`keyproxy listening on 127.0.0.1:${PORT} -> ${upstream.host}`);
});
