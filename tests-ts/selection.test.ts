import {test, expect} from 'bun:test';
import {select} from '../src/core/selection.ts';
import {build_summary} from '../src/core/summary.ts';
import {Finding} from '../src/core/contract.ts';
import type {ThreadRecord} from '../src/core/contract.ts';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
+added line
 two
 three
diff --git a/lockfile.lock b/lockfile.lock
--- a/lockfile.lock
+++ b/lockfile.lock
@@ -1 +1,2 @@
 keep
+noise
`;

function finding(overrides: Partial<{path: string; line: number; severity: string; title: string; detail: string}> = {}): Finding {
  // A real Finding, not a literal: the pipeline rekeys findings, and fid is derived from the
  // coordinate and title rather than passed in.
  return new Finding({
    path: 'src/a.ts', line: 2, severity: 'high',
    title: 'slot over-admitted', detail: 'ran the probe, saw 4', ...overrides,
  });
}

test('a finding inside a hunk is posted inline, one outside it is summary-only', () => {
  const {inline, overflow} = select([finding({line: 2}), finding({line: 99, title: 'other defect'})],
    {diff: DIFF, open_threads: [], resolved_history: [], max_findings: 30});
  expect(inline.map(f => f.line)).toEqual([2]);
  expect(overflow.map(f => f.line)).toEqual([99]);
});

test('a finding on an ignored path never reaches a thread', () => {
  const {inline, overflow, dropped} = select([finding({path: 'lockfile.lock', line: 2})],
    {diff: DIFF, open_threads: [], resolved_history: [], max_findings: 30});
  expect(inline.length + overflow.length).toBe(0);
  expect(dropped.paths).toBe(1);
});

test('a self-retracted claim is dropped before anything else looks at it', () => {
  // The retraction rule is position-sensitive: a claim whose body says "no bug here" *at the end*
  // is withdrawn, while "No bug there. The actual defect is ..." is kept.
  const {inline, dropped} = select([finding({detail: 'No bug here.'})],
    {diff: DIFF, open_threads: [], resolved_history: [], max_findings: 30});
  expect(inline.length).toBe(0);
  expect(dropped.retracted).toBe(1);
});

test('an open thread at the same span suppresses a repeat', () => {
  const target = finding();
  const open: ThreadRecord[] = [{path: 'src/a.ts', line: 2, fid: target.fid, title: 'slot over-admitted'}];
  const {inline, dropped} = select([target],
    {diff: DIFF, open_threads: open, resolved_history: [], max_findings: 30});
  expect(inline.length).toBe(0);
  expect(dropped.dupe).toBe(1);
});

test('a resolved finding re-derived with the same title is withheld, not posted', () => {
  const resolved: ThreadRecord[] = [{path: 'src/a.ts', line: 2, fid: 'aaaaaaaaaa', title: 'slot over-admitted'}];
  const {inline, dropped} = select([finding({title: 'Slot over-admitted!'})],
    {diff: DIFF, open_threads: [], resolved_history: resolved, max_findings: 30});
  expect(inline.length).toBe(0);
  expect(dropped.resolved).toBe(1);
});

test('the cap keeps the highest severity and reports the rest as dropped', () => {
  const many = [
    finding({line: 2, severity: 'low', title: 'low one'}),
    finding({line: 2, severity: 'high', title: 'high one'}),
  ];
  const {inline, dropped} = select(many, {diff: DIFF, open_threads: [], resolved_history: [], max_findings: 1});
  expect(inline.length).toBe(1);
  expect(inline[0].severity).toBe('high');
  expect(dropped.cap).toBe(1);
});

test('the summary states what it withheld instead of silently shrinking', () => {
  const text = build_summary([], [], {dupes: [], resolved: []}, {
    model: 'coral/x', image: null, imageDigest: null, head: 'a'.repeat(40), base: 'b'.repeat(40), diffLines: 7,
    elapsedS: 1.5, toolCalls: 3, droppedPaths: 1, droppedCap: 2, droppedDupe: 0,
    droppedResolved: 0, droppedRetracted: 1, incomplete: null,
  }, '9.9.9');
  expect(text).toContain('No bugs found in this diff.');
  expect(text).toContain('1 finding(s) on ignored paths were dropped.');
  expect(text).toContain('2 further finding(s)');
  expect(text).toContain('1 self-retracted finding(s)');
  expect(text).not.toContain('incomplete');
});

test('an incomplete run says so in the review body', () => {
  const text = build_summary([], [], {dupes: [], resolved: []}, {
    model: 'm', image: null, imageDigest: null, head: 'a'.repeat(40), base: 'b'.repeat(40), diffLines: 1, elapsedS: 0,
    toolCalls: 0, droppedPaths: 0, droppedCap: 0, droppedDupe: 0, droppedResolved: 0,
    droppedRetracted: 0, incomplete: 'open review threads could not be read.',
  }, '9.9.9');
  expect(text).toContain('**This review is incomplete:** open review threads could not be read.');
});

test('a bounded scan is a caveat, not an incomplete review', () => {
  // A spent tool budget means the reviewer stopped looking early, not that its evidence is
  // unusable. Treating it as incomplete blocked a large pull request on a cap we chose.
  const text = build_summary([], [], {dupes: [], resolved: []}, {
    model: 'm', image: null, imageDigest: null, head: 'a'.repeat(40), base: 'b'.repeat(40), diffLines: 2307, elapsedS: 146,
    toolCalls: 80, droppedPaths: 0, droppedCap: 0, droppedDupe: 0, droppedResolved: 0,
    droppedRetracted: 0, incomplete: null, caveat: 'the reviewer reached its tool-call budget.',
  }, '9.9.9');
  expect(text).toContain('Partial scan: the reviewer reached its tool-call budget.');
  expect(text).not.toContain('This review is incomplete');
});

test('the summary reports how long the scan took, not zero', () => {
  const text = build_summary([], [], {dupes: [], resolved: []}, {
    model: 'm', image: null, imageDigest: null, head: 'a'.repeat(40), base: 'b'.repeat(40), diffLines: 13, elapsedS: 146,
    toolCalls: 72, droppedPaths: 0, droppedCap: 0, droppedDupe: 0, droppedResolved: 0,
    droppedRetracted: 0, incomplete: null,
  }, '9.9.9');
  expect(text).toContain('72 tool call(s), 146.0s');
});


test('the review names the image it ran and the digest the tag meant', () => {
  // `:latest` is the pinned-to-nothing case: without the digest, a finding cannot be reproduced
  // once the tag moves on.
  const text = build_summary([], [], {dupes: [], resolved: []}, {
    model: 'm', head: 'a'.repeat(40), base: 'b'.repeat(40), diffLines: 13, elapsedS: 146,
    toolCalls: 72, droppedPaths: 0, droppedCap: 0, droppedDupe: 0, droppedResolved: 0,
    droppedRetracted: 0, incomplete: null,
    image: 'ghcr.io/coral-bricks-ai/goby-review:latest', imageDigest: 'sha256:' + 'c'.repeat(64),
  }, '9.9.9');
  expect(text).toContain('Image: `ghcr.io/coral-bricks-ai/goby-review:latest` (`sha256:cccc');
});

test('an unresolved digest says so rather than pretending the tag identifies the bytes', () => {
  const text = build_summary([], [], {dupes: [], resolved: []}, {
    model: 'm', head: 'a'.repeat(40), base: 'b'.repeat(40), diffLines: 1, elapsedS: 0,
    toolCalls: 0, droppedPaths: 0, droppedCap: 0, droppedDupe: 0, droppedResolved: 0,
    droppedRetracted: 0, incomplete: null, image: 'ghcr.io/x/y:latest', imageDigest: null,
  }, '9.9.9');
  expect(text).toContain('(digest unresolved)');
});
