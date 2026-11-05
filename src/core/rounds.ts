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
