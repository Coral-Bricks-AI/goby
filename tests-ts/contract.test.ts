import { describe, expect, test } from 'bun:test';
import * as F from '../src/core/contract.ts';
import { corpus, replay } from './fixtures/replay.ts';

describe('Contract corpus', () => {
  test('the corpus still covers the original suite', () => {
    expect(corpus.original_tests).toBeGreaterThanOrEqual(75);
  });
  for (const [i, receipt] of corpus.calls.entries()) {
    if (receipt.namespace !== 'contract') continue;
    test(`${i}: ${receipt.case} / ${receipt.name}`, () => {
      if (receipt.error) expect(() => replay(F, receipt)).toThrow(RangeError);
      else expect(replay(F, receipt)).toEqual(receipt.result);
    });
  }
});

test('normalization, rekey, first occurrence identity and cap ordering', () => {
  const first = new F.Finding({ path: 'b/x.py', line: 3, title: 'Off by one', severity: 'low' });
  const later = new F.Finding({ path: 'x.py', line: 3, title: 'off by one', severity: 'high' });
  expect(first.fid).not.toBe(later.fid);
  first.path = 'x.py';
  const other = new F.Finding({ path: 'y.py', line: 4, title: 'Other', severity: 'high' });
  const out = F.dedupe_findings([first, other, later]);
  expect(out).toEqual([first, other]);
  expect(out[0]).toBe(first);
  expect(first.fid).toBe(later.fid);
  expect(first.severity).toBe('high');
  expect(F.select_findings(out, 1)).toEqual([[first], 1]);
});

test('strict option object rejects invalid entries and malformed last block', () => {
  const valid = { path: 'a.py', line: 3, severity: 'high', title: 'T' };
  const mixed = '```json\n' + JSON.stringify([null, valid]) + '\n```';
  expect(F.parse_findings(mixed)?.length).toBe(1);
  expect(F.parse_findings(mixed, { strict: true })).toBeNull();
  expect(F.parse_findings('```json\n[]\n```\n```json\n[\n```', { strict: true })).toBeNull();
});

test('moved range covers both anchors but not invented intermediate lines', () => {
  const thread: F.ThreadRecord = { path: 'a.py', line: 84, start_line: 80, marker_start: 9, marker_end: 14, outdated: false };
  const findings = [9, 12, 50, 82, 84, 85].map(line => new F.Finding({ path: 'a.py', line, severity: 'low', title: 'T' }));
  const [fresh, withheld] = F.split_already_raised(findings, [thread]);
  expect(fresh.map(f => f.line)).toEqual([50, 85]);
  expect(withheld.map(f => f.line)).toEqual([9, 12, 82, 84]);
});

test('resolution plan preserves caller records and does not resolve unverified fixes', () => {
  const older = { thread_id: 'old', path: 'a', line: 3, created_at: '2026-01-01' };
  const newer = { ...older, thread_id: 'new', created_at: '2026-02-01' };
  const stale = { path: 'b', outdated: true };
  const unrelated = { path: 'c', line: 5 };
  const threads = [newer, stale, unrelated, older];
  const plan = F.plan_thread_resolution(threads);
  expect(plan.map(([t]) => t)).toEqual([stale, newer]);
  expect(plan[1][0]).toBe(newer);
  expect(threads).toEqual([newer, stale, unrelated, older]);
});

test('a fence inside a finding detail does not hide the payload from the strict parser', () => {
  // `finish` serialises the emitted findings with JSON.stringify and parses them strictly. A
  // detail that quotes the probe it ran contains a fence, and the fence scan yielded that block
  // before the array holding the finding, so the strict abort fired on text the harness itself
  // had produced and every finding was lost.
  const payload = JSON.stringify([{
    path: 'src/a.ts', line: 2, severity: 'high', title: 'off-by-one in the writer',
    detail: 'ran:\n```js\nfor (let i = 0; i <= n; i++) {}\n```\nstill fails',
  }]);
  const parsed = F.parse_findings(payload, true);
  expect(parsed).toHaveLength(1);
  expect(parsed![0]!.path).toBe('src/a.ts');
  // A genuinely off-contract payload is still refused.
  expect(F.parse_findings('[{"path":"a.ts","line":2,"title":"T"', true)).toBeNull();
});

test('a findings record that is not an array is unreadable, not empty', () => {
  // Skipping it left `emitted` empty, so the strict parse was asked about `'[]'` — the one input
  // that means "no findings" — and an off-contract reply became a green review.
  const bad = F.emitted_findings([{kind: 'findings', findings: {path: 'a.ts', line: 2, title: 'T'}}]);
  expect(bad).toEqual([[], true]);
  expect(F.emitted_findings([{kind: 'findings'}, {kind: 'progress'}])).toEqual([[], true]);

  const good = [{path: 'a.ts', line: 2, severity: 'high', title: 'T'}, {path: 'b.ts', line: 3, severity: 'low', title: 'U'}];
  expect(F.emitted_findings([{kind: 'findings', findings: good}])).toEqual([good, false]);
  expect(F.emitted_findings([])).toEqual([[], false]);
});
