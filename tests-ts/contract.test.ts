import { describe, expect, test } from 'bun:test';
import * as F from '../src/core/contract.ts';
import { corpus, replay } from './fixtures/replay.ts';

describe('Contract corpus', () => {
  test('verbatim system prompt and original test coverage', () => {
    expect(F.SYSTEM_PROMPT).toBe(corpus.system_prompt);
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
