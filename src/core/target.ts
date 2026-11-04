/**
 * Is this review still about the commit it was started for?
 *
 * The comparison is the kind that looks obviously right and is not: the API reports a base *ref*
 * (`main`) and a base *commit*, and the workflow supplies a commit. Comparing the two silently
 * rejects every review with "PR base is main, not 013c538…", which is what happened the first time
 * this ran end to end. It is a pure function here, with tests, so the next version of it cannot
 * repeat that.
 */
export interface PrMeta {
  head_sha: string;
  base_ref: string;
  base_sha: string;
}

export interface Expected {
  head: string;
  base: string;
}

/** `null` when the review may proceed, otherwise the reason it may not. */
export function check_target(meta: PrMeta, expected: Expected): string | null {
  if (meta.head_sha !== expected.head) {
    return `PR head is ${meta.head_sha.slice(0, 10)}, not ${expected.head.slice(0, 10)}; superseded`;
  }
  if (meta.base_sha !== expected.base) {
    return `PR base commit is ${meta.base_sha.slice(0, 10)}, not ${expected.base.slice(0, 10)}; superseded`;
  }
  return null;
}
