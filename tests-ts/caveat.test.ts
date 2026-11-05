import {test, expect} from 'bun:test';
import {caveat_for} from '../src/core/caveat.ts';

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
  const unique = [...new Set(records.map(caveat_for).filter(Boolean))];
  expect(unique).toHaveLength(1);
});
