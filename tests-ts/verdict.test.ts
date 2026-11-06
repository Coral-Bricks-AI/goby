import {describe, expect, test} from 'bun:test';
import {receiptMarker, review_landed, type ReviewReceipt} from '../src/core/verdict.ts';

const head = 'a'.repeat(40);
const receipt = (changes: Partial<ReviewReceipt> = {}): ReviewReceipt => ({
  schema: 2, head_sha: head, base_ref: 'main', diff_sha256: 'b'.repeat(64),
  complete: true, agent: true, unthreaded: 0, finding_ids: [], ...changes,
});
const review = (body: string, sha = head) => ({head: sha, body: `**Goby Review**\n\n${body}`});

describe('a review POST the API stored but answered with an error', () => {
  test('a complete receipt for this head means the review landed', () => {
    expect(review_landed([review(receiptMarker(receipt()))], head)).toBe(true);
  });

  test('an incomplete review is not evidence of publication', () => {
    // prepare would have reused a complete review, so an incomplete one is an earlier attempt.
    expect(review_landed([review(receiptMarker(receipt({complete: false})))], head)).toBe(false);
    expect(review_landed([{head, body: 'no receipt here'}], head)).toBe(false);
  });

  test('a review for another head is not ours', () => {
    expect(review_landed([review(receiptMarker(receipt()), 'c'.repeat(40))], head)).toBe(false);
    expect(review_landed([], head)).toBe(false);
  });
});
