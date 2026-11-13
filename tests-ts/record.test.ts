import { describe, expect, test } from 'bun:test';
import { parseRecord, recordMarker, type RunRecord } from '../src/core/record.ts';

const record = (changes: Partial<RunRecord> = {}): RunRecord => ({
  schema: 1, product: 'review', v: '0.4.0', complete: true, model: 'coral/x', measured: true,
  agent_s: 118.4, model_s: 61.2, tools_s: 39.9, other_s: 17.3, turns: 9, tool_calls: 31,
  tool_s: { bash: 30.2, read: 9.7 },
  requests: { count: 9, p50_s: 4.1, p95_s: 9.3, max_s: 9.3 },
  timeouts: 1, blocked: null,
  tokens: { input: 41, output: 6210, cache_read: 288000, cache_write: 5400, reasoning: 3600 },
  cost: { cents: 12.34, usd: 0.1234, note: null },
  ...changes,
});

describe('the run marker', () => {
  test('round-trips the record unchanged', () => {
    const body = `A review body.\n\n${recordMarker(record())}`;
    expect(parseRecord(body)).toEqual(record() as unknown as RunRecord);
  });

  test('survives a string that would close the comment early', () => {
    // A JSON string may contain the comment terminator, and an unescaped one would end the
    // marker there and leave the rest of the JSON in the body as visible text.
    const hostile = record({ model: 'weird-->model' });
    const body = recordMarker(hostile);
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(body.endsWith(' -->')).toBe(true);
    expect(parseRecord(body)?.model).toBe('weird-->model');
  });

  test('is about a kilobyte, not tens of them', () => {
    // The marker is in a body every human and every reader of the pull request pays for. The
    // per-call array `timing.py` emits is why this is asserted rather than assumed: with it the
    // marker is ~3 KB for a 30-call run and ~10 KB for a long one.
    expect(recordMarker(record()!).length).toBeLessThan(1024);
    const many = record({ tool_s: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`tool${i}`, i * 1.5])) });
    expect(recordMarker(many).length).toBeLessThan(2048);
  });

  test('one marker per body, or none', () => {
    expect(parseRecord('no marker here')).toBeNull();
    expect(parseRecord(`${recordMarker(record())}\n${recordMarker(record())}`)).toBeNull();
  });

  test('an unreadable record is null, not a guess', () => {
    expect(parseRecord('<!-- goby-run {not json} -->')).toBeNull();
    expect(parseRecord('<!-- goby-run ["not","an","object"] -->')).toBeNull();
    expect(parseRecord('<!-- goby-run {"product":"review"} -->')).toBeNull();
    expect(parseRecord('<!-- goby-run {"schema":1} -->')).toBeNull();
  });

  test('a record from a later schema is returned, so a reader can still see the fields it knows',
    () => {
      const future = record({ schema: 99, something_new: { nested: true } });
      expect(parseRecord(recordMarker(future))?.something_new).toEqual({ nested: true });
    });

  test('the gate receipt and the run marker do not read each other', () => {
    const body = `${recordMarker(record())}\n<!-- goby-gate {"schema":2} -->`;
    expect(parseRecord(body)?.product).toBe('review');
  });
});
