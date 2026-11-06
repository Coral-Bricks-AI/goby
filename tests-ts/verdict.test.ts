import {describe, expect, test} from 'bun:test';
import {receiptMarker, review_landed, type ReviewReceipt} from '../src/core/verdict.ts';

const head = 'a'.repeat(40);
const receipt = (changes: Partial<ReviewReceipt> = {}): ReviewReceipt => ({
  schema: 2, head_sha: head, base_ref: 'main', diff_sha256: 'b'.repeat(64),
  complete: true, agent: true, unthreaded: 0, finding_ids: [], ...changes,
});
const review = (body: string, sha = head) => ({head: sha, body: `**Goby Review**\n\n${body}`});

describe('a review POST the API stored but answered with an error', () => {
  test('this run\'s receipt on the pull request means the review landed', () => {
    expect(review_landed([review(receiptMarker(receipt()))], receipt())).toBe(true);
  });

  test('an older complete review for the same head is not this run\'s', () => {
    // A retargeted pull request keeps a complete receipt for an older diff. Accepting it would
    // swallow a POST that really failed and report findings that were never published.
    const stale = receiptMarker(receipt({diff_sha256: 'c'.repeat(64)}));
    expect(review_landed([review(stale)], receipt())).toBe(false);
    expect(review_landed([review(receiptMarker(receipt({complete: false})))], receipt())).toBe(false);
    expect(review_landed([review(receiptMarker(receipt({finding_ids: ['ab12']})))], receipt())).toBe(false);
    expect(review_landed([{head, body: 'no receipt here'}], receipt())).toBe(false);
  });

  test('a review for another head is not ours', () => {
    expect(review_landed([review(receiptMarker(receipt()), 'c'.repeat(40))], receipt())).toBe(false);
    expect(review_landed([], receipt())).toBe(false);
  });
});
