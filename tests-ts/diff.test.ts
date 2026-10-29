import { describe, expect, test } from 'bun:test';
import * as D from '../src/core/diff.ts';
import { corpus, replay } from './fixtures/replay.ts';

describe('Diff corpus', () => {
  for (const [i, receipt] of corpus.calls.entries()) {
    if (receipt.namespace !== 'diff') continue;
    test(`${i}: ${receipt.case} / ${receipt.name}`, () => {
      expect(replay(D, receipt)).toEqual(receipt.result);
    });
  }
});

test('bounds, omitted vs zero counts, deletion and section reset', () => {
  const h = D.parse_hunks('@@ -1 +1 @@\n+++ b/x\n@@ -1 +2 @@ heading\n@@ -4,3 +7,0 @@\n@@ -8 +12,3 @@\n' +
    'diff --git a/binary b/binary\nBinary files differ\n@@ -1 +90 @@\n+++ /dev/null\n@@ -1 +92 @@\n');
  expect(Object.keys(h)).toEqual(['x']);
  expect(h.x).toEqual([{ new_start: 2, new_count: 1 }, { new_start: 12, new_count: 3 }]);
  expect([1, 2, 3, 11, 12, 14, 15].map(line => D.line_in_hunks(h, 'x', line))).toEqual([false, true, false, false, true, true, false]);
  expect(D.clamp_end_to_hunk(h, 'x', 12, 90)).toBe(14);
  expect(D.clamp_end_to_hunk(h, 'x', 3, 90)).toBeNull();
  expect(D.clamp_end_to_hunk(h, 'x', 12, null)).toBeNull();
});

test('real a/b directories, collisions, unknown paths and prototype keys', () => {
  const h = D.parse_hunks(['x.py', 'b/x.py', 'a/y.py', '__proto__', 'constructor']
    .map(p => `diff --git a/${p} b/${p}\n+++ b/${p}\n@@ -1 +1 @@`).join('\n'));
  expect(D.resolve_diff_path('b/x.py', h)).toEqual(['b/x.py', true]);
  expect(D.resolve_diff_path('a/x.py', h)).toEqual(['x.py', false]);
  expect(D.resolve_diff_path('a/y.py', h)).toEqual(['a/y.py', false]);
  expect(D.resolve_diff_path('b/a/y.py', h)).toEqual(['a/y.py', false]);
  expect(D.resolve_diff_path('b/nope', h)).toEqual(['b/nope', false]);
  expect(D.line_in_hunks(h, '__proto__', 1)).toBe(true);
  expect(D.line_in_hunks(h, 'constructor', 1)).toBe(true);
  expect(D.line_in_hunks({}, 'constructor', 1)).toBe(false);
});
