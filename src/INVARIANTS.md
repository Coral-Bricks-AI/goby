<!-- Passed verbatim to a goby cleaner as its brief for this directory.
     A defect here is code that makes one of these invariants false. -->

# src (the reviewer's decisions)

1. **What may be posted is decided by code, not by the model.** `parse_findings` returns `null` on an
   off-contract reply and the review fails; it never returns `[]` for an unparseable answer. A
   self-retracted claim is dropped, a finding on an ignored path is dropped, a re-derivation of a
   resolved thread is withheld, and a repeat inside an open thread's span is suppressed.
2. **A withheld finding is named, never silently dropped.** Every filter that removes something
   reports a count or the finding itself in the review body. Silence reads as "clean".
3. **The gate is fail-closed in two places.** A non-Boolean fact is `false`, and the compiled rule
   requires all ten. Neither can be satisfied by a missing value.
4. **A partial scan is not a failed review.** A spent turn or tool budget is a caveat in the body;
   an unreadable thread list, or a reviewer that never reported, is `complete: false` and the gate
   refuses it. Conflating the two blocks merges for a cap we chose.
5. **The caveat a human reads matches the reason the harness recorded.** One block reason per
   sentence, deduped: a turn block is not a tool-call block.

## Known-fragile areas

`selection.ts` and `summary.ts` are pure and tested; the risk is in what they are *handed* —
`reviewRun.ts` decides which records become findings and which become caveats, and it runs after the
agent has exited, on files the agent wrote.

## Known non-findings

- The findings schema is deliberately strict about `path`/`line` and tolerant about severity: a
  mislabelled severity is a ranking problem, an unparseable coordinate is a lost finding.
- "A 5xx on the review or status POST that GitHub actually stored is reported as a failed review"
  — accepted. A commit status and a review POST have no compare-and-swap, so a write can land and
  still be answered with an error; reading every one back is more machinery than a rare, visible,
  re-runnable failure is worth. The run exits non-zero and both statuses say `error` (#62, #66, #85).
