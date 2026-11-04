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
