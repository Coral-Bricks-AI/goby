import {test, expect} from 'bun:test';
import {gate_enabled} from '../src/core/flags.ts';

test('the gate is off unless something says on', () => {
  // Until a repository requires it in branch protection, a gate failure is noise on every pull
  // request — and it can fail for reasons that have nothing to do with the code.
  expect(gate_enabled({})).toBe(false);
  expect(gate_enabled({GOBY_GATE: ''})).toBe(false);
  expect(gate_enabled({GOBY_GATE: 'off'})).toBe(false);
  expect(gate_enabled({GOBY_GATE: 'false'})).toBe(false);
  expect(gate_enabled({GOBY_GATE: '0'})).toBe(false);
  expect(gate_enabled({GOBY_GATE: 'on'})).toBe(true);
  expect(gate_enabled({GOBY_GATE: ' ON '})).toBe(true);
});
