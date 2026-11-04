import {test, expect} from 'bun:test';
import {parse_image, resolve_digest} from '../src/core/image.ts';

test('an image reference splits into registry, repository and tag', () => {
  expect(parse_image('ghcr.io/coral-bricks-ai/goby-review:latest'))
    .toEqual({registry: 'ghcr.io', repository: 'coral-bricks-ai/goby-review', tag: 'latest'});
  // No tag means latest, which is how docker reads it.
  expect(parse_image('ghcr.io/a/b')?.tag).toBe('latest');
  expect(parse_image('localhost:5000/a/b:v1')).toEqual({registry: 'localhost:5000', repository: 'a/b', tag: 'v1'});
  expect(parse_image('nonsense')).toBeNull();
});

test('a digest reference needs no registry lookup', async () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  expect(await resolve_digest(`ghcr.io/a/b@${digest}`)).toBe(digest);
});

test('an unreachable registry returns null instead of failing the review', async () => {
  // Attribution must never be the reason a review does not post.
  expect(await resolve_digest('127.0.0.1:1/nothing/here:latest')).toBeNull();
});


test('the job token is never sent to a registry other than GitHub\'s', async () => {
  // GOBY_IMAGE is configurable for custom images, and that token can write pull requests and
  // statuses. Sending it to whatever host an image names is a credential leak with a config change.
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${input} ${JSON.stringify(init?.headers ?? {})}`);
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  try {
    await resolve_digest('docker.io/company/custom-review:latest', 'ghp_SECRET');
    await resolve_digest('ghcr.io/coral-bricks-ai/goby-review:latest', 'ghp_SECRET');
  } finally {
    globalThis.fetch = original;
  }
  const headers = (entry: string) => {
    const quoted = /"authorization":"Basic ([A-Za-z0-9+/=]+)"/.exec(entry);
    return quoted ? Buffer.from(quoted[1], 'base64').toString() : '';
  };
  const docker = seen.find(entry => entry.includes('docker.io'))!;
  const github = seen.find(entry => entry.includes('ghcr.io'))!;
  expect(headers(docker)).toBe('');
  expect(headers(github)).toContain('ghp_SECRET');
});
