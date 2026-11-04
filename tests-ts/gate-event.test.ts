import {test, expect} from 'bun:test';
import {resolve_gate_target} from '../src/core/gateEvent.ts';

const SHA = 'a'.repeat(40);

test('a workflow_run names its single pull request', () => {
  expect(resolve_gate_target({
    name: 'workflow_run',
    event: {workflow_run: {pull_requests: [{number: 12, head: {sha: SHA}}]}},
  })).toEqual({pr: 12, head: SHA});
});

test('no pull request, or several, changes nothing', () => {
  // Guessing here would re-gate a pull request nobody asked about.
  expect(resolve_gate_target({name: 'workflow_run', event: {workflow_run: {pull_requests: []}}}))
    .toBe('no unambiguous PR identity; no gate will be changed');
  expect(resolve_gate_target({name: 'workflow_run', event: {workflow_run: {pull_requests: [
    {number: 1, head: {sha: SHA}}, {number: 2, head: {sha: SHA}}]}}}))
    .toBe('no unambiguous PR identity; no gate will be changed');
  expect(resolve_gate_target({name: 'workflow_run', event: {}}))
    .toBe('no unambiguous PR identity; no gate will be changed');
});

test('a dispatch must supply both a positive PR and a full head', () => {
  expect(resolve_gate_target({name: 'workflow_dispatch', event: {}, inputs: {pr: '13', head: SHA}}))
    .toEqual({pr: 13, head: SHA});
  for (const inputs of [{}, {pr: '0', head: SHA}, {pr: 'x', head: SHA}, {pr: '13', head: 'abc'}]) {
    expect(typeof resolve_gate_target({name: 'workflow_dispatch', event: {}, inputs})).toBe('string');
  }
});

test('a malformed workflow_run payload is reported, not trusted', () => {
  expect(resolve_gate_target({name: 'workflow_run', event: {workflow_run: {pull_requests: [{number: 'x'}]}}}))
    .toBe('invalid PR number or head SHA in the event');
});
