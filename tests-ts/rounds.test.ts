import {test, expect} from 'bun:test';
import {review_budget, reuse_evidence} from '../src/core/rounds.ts';

const completed = (head: string) => ({head, complete: true});
const incomplete = (head: string) => ({head, complete: false});

test('no prior review means the reviewer runs', () => {
  expect(review_budget(1, [], 'new').stop).toBe(false);
});

test('one completed review spends the round', () => {
  const decision = review_budget(1, [completed('a'.repeat(40))], 'b'.repeat(40));
  expect(decision.stop).toBe(true);
  expect(decision.reason).toContain('gets 1');
});

test('an incomplete review does not spend it', () => {
  // Otherwise one failed run — an unreadable thread list, a truncated answer — means the pull
  // request is never reviewed again.
  const decision = review_budget(1, [incomplete('a'.repeat(40))], 'b'.repeat(40));
  expect(decision.stop).toBe(false);
});

test('a higher cap allows exactly that many reviews', () => {
  const prior = [completed('a'.repeat(40)), completed('b'.repeat(40))];
  expect(review_budget(2, prior, 'c'.repeat(40)).stop).toBe(true);
  expect(review_budget(3, prior, 'c'.repeat(40)).stop).toBe(false);
});

test('zero means no cap', () => {
  expect(review_budget(0, [completed('a'.repeat(40))], 'b'.repeat(40)).stop).toBe(false);
});

test('a retargeted head still hands the gate its receipt', () => {
  // The head is unchanged and the base moved. A receipt exists, so the gate must re-read it and
  // refuse the base/digest mismatch; `rounds` skipped that refresh and left the old green.
  expect(reuse_evidence(true, true)).toBe('same-head');
});

test('a head with no receipt leaves the gate alone', () => {
  // No evidence exists, so a gate refresh can only fail closed and stay failed.
  expect(reuse_evidence(false, true)).toBe('rounds');
  expect(reuse_evidence(false, false)).toBeNull();
});
