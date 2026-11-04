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
