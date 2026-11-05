import {test, expect} from 'bun:test';
import {caveat_for, caveats_for} from '../src/core/caveat.ts';

test('a turn-blocked run is not described as a tool-call block', () => {
  // The extension records the reason; the reader gets the sentence. Saying "tool-call budget" for a
  // turn-blocked run misreports how far the reviewer got.
  const turns = caveat_for({kind: 'blocked', reason: 'turns', turns: 21});
  expect(turns).toContain('turn budget (21 turns)');
  expect(turns).not.toContain('tool-call');
  const calls = caveat_for({kind: 'blocked', reason: 'tool_calls', turns: 4});
  expect(calls).toContain('tool-call budget');
});

test('anything that is not a block has no caveat', () => {
  expect(caveat_for({kind: 'findings'})).toBeNull();
});

test('the same caveat is not repeated once per blocked call', () => {
  // The extension writes one blocked record per blocked tool call; a body listing the same sentence
  // seven times is what that looks like undeduped.
  const records = Array.from({length: 7}, () => ({kind: 'blocked', reason: 'tool_calls', turns: 12}));
  expect(caveats_for(records)).toHaveLength(1);
});

test('different turn counts for the same reason are one caveat', () => {
  // A run blocked at 21, 22 and 23 is one condition; the count changes, the sentence must not.
  const records = [21, 22, 23].map(turns => ({kind: 'blocked', reason: 'turns', turns}));
  const out = caveats_for(records);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('turn budget (21 turns)');
});

test('a turn block and a tool-call block are two caveats', () => {
  const out = caveats_for([
    {kind: 'blocked', reason: 'turns', turns: 50},
    {kind: 'blocked', reason: 'tool_calls', turns: 10},
  ]);
  expect(out).toHaveLength(2);
  expect(out[0]).toContain('turn budget');
  expect(out[1]).toContain('tool-call budget');
});
