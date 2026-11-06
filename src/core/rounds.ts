/**
 * How many reviews a pull request gets.
 *
 * Only a *completed* review spends a round: a review whose receipt says `complete: false` — the
 * thread list could not be read, the answer was truncated — must not suppress the next push, or one
 * bad first run would mean the pull request is never reviewed again.
 */
export interface PriorReview {
  head: string;
  complete: boolean;
}

export interface RoundDecision {
  /** True when the reviewer should not run. */
  stop: boolean;
  reason: string | null;
}

export function review_budget(maxRounds: number, prior: readonly PriorReview[], head: string): RoundDecision {
  if (maxRounds <= 0) return { stop: false, reason: null };
  const completed = prior.filter(review => review.complete);
  if (completed.length < maxRounds) return { stop: false, reason: null };
  const heads = completed.map(review => review.head.slice(0, 10));
  return {
    stop: true,
    reason: `this pull request has had ${completed.length} review(s) (${heads.join(', ')}); ` +
      `it gets ${maxRounds}, and the post-merge cleaner takes it from there`,
  };
}

/** What a reused round leaves the gate, when anything is left at all. */
export type ReusedEvidence = 'same-head' | 'rounds' | null;

/**
 * Which evidence a reused round leaves the gate, given whether a *completed* receipt exists for
 * this head.
 *
 * `same-head` is not "the receipt still matches": a retargeted pull request keeps the head and
 * loses the base, and comparing the receipt's base_ref and diff digest against the current pull
 * request is the gate's job. Reporting `rounds` whenever `sameHead` was false skipped that
 * comparison and left a green check standing on a diff nobody had reviewed.
 *
 * `rounds` therefore means only "this head has no receipt at all", where a gate refresh can
 * never succeed and asking for it would fail closed forever.
 */
export function reuse_evidence(has_completed_receipt: boolean, stopped: boolean): ReusedEvidence {
  return has_completed_receipt ? 'same-head' : stopped ? 'rounds' : null;
}
