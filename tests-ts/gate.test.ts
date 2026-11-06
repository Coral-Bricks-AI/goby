import {describe, expect, test} from 'bun:test';
import {finish_failure_should_report, HeadChanged} from '../src/core/gate.ts';

describe('a failure after prepare resolves the statuses', () => {
  test('an off-contract payload resolves the pending Goby Review and Goby Gate', () => {
    // `finish` runs after prepare posted `pending`. Exiting on a throw left them pending forever:
    // a pull request blocked with nothing to read, which review/INVARIANTS.md 1 forbids.
    expect(finish_failure_should_report(new Error('report_findings produced an off-contract payload'))).toBe(true);
    expect(finish_failure_should_report('not an Error')).toBe(true);
  });

  test('a moved head is not ours to report', () => {
    // The run that superseded this one owns the statuses; posting `error` would race it.
    expect(finish_failure_should_report(new HeadChanged('head moved'))).toBe(false);
  });
});
