import {test, expect} from 'bun:test';
import {check_target} from '../src/core/target.ts';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const meta = {head_sha: HEAD, base_ref: 'main', base_sha: BASE};

test('the expected commit and base commit allow the review', () => {
  expect(check_target(meta, {head: HEAD, base: BASE})).toBeNull();
});

test('the base is compared as a commit, not as a branch name', () => {
  // The first end-to-end run rejected every review with "PR base is main, not 013c538…", because it
  // compared the expected SHA against the API's base ref.
  expect(check_target(meta, {head: HEAD, base: 'main'})).toContain('superseded');
  expect(check_target(meta, {head: HEAD, base: BASE})).toBeNull();
});

test('a moved head is named, so the log says which commit it moved to', () => {
  const moved = check_target({...meta, head_sha: 'c'.repeat(40)}, {head: HEAD, base: BASE});
  expect(moved).toContain('PR head is cccccccccc');
  expect(moved).toContain('superseded');
});
