import {describe, expect, test} from 'bun:test';
import {finish_failure_should_report, HeadChanged} from '../src/core/gate.ts';

describe('a finish failure only reports on the statuses it owns', () => {
  test('before the review is published, a throw resolves the pending statuses', () => {
    // `prepare` posted `pending`. Exiting on a throw left them pending forever: a pull request
    // blocked with nothing to read, which review/INVARIANTS.md 1 forbids.
    expect(finish_failure_should_report(new Error('report_findings produced an off-contract payload'), false)).toBe(true);
    expect(finish_failure_should_report('not an Error', false)).toBe(true);
  });

  test('after the review is published, its status is the verdict', () => {
    // A gate refresh that fails after `post_review` used to rewrite `Goby Review=success` to
    // `error`, losing a review that exists and leaving the gate refusing that head.
    expect(finish_failure_should_report(new Error('post_gate_status HTTP 502'), true)).toBe(false);
  });

  test('a moved head is not ours to report', () => {
    // The run that superseded this one owns the statuses; posting `error` would race it.
    expect(finish_failure_should_report(new HeadChanged('head moved'), false)).toBe(false);
  });
});
