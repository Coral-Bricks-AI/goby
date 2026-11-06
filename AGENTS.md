# Goby repo notes for coding agents

Goby ships images; consumers default to `:latest` for both review and cleaners. Prefer changes that
live inside the image — code, prompts, extensions, and the image-owned defaults — so a merge to main
and the image publish reach every consumer automatically.

- Tunable defaults belong in `review/defaults.env` or `cleaners/defaults.env`, not in workflow YAML
  or a vendored copy. Workflow-only changes do not propagate through `:latest`; consumers must
  re-copy them.
- YAML changes are normal while the product is young. Keep the shipped workflow and the consumer
  copy in sync, and say in the PR that consumers need to re-copy.
- Only the default branch publishes `:latest`; reviews report the digest they resolved, so a finding
  stays attributable to the bytes that produced it.
- A merge performed with `GITHUB_TOKEN` starts no `push` workflows, so `:latest` would never publish
  and the post-merge cleaners would never scan. `auto-merge.yml` merges with `AUTO_MERGE_TOKEN` for
  that reason; do not simplify it back to the Actions token, and do not add a fallback to it.

## A review round, from the other side

`main` requires every conversation resolved before a merge, and `auto-merge` has the pull request
armed. So the merge is yours to release, and the order of the four steps is what keeps it honest:

1. **Read every thread**, goby's and anyone else's, and decide whether the finding is a real defect
   in this change. A finding you disagree with is a reply, not a silent resolve.
2. **Fix it, then commit.**
3. **Push before you reply.** The push is what puts the required checks back to pending on the
   fixed head; resolving first releases a merge onto the head that still has the bug.
4. **Reply `fixed in <short sha>`, then resolve the thread.**

A resolved thread is evidence, not a to-do: goby keeps resolved threads so it does not re-report the
same bug, which means resolving something you did not fix suppresses it on every later round. Say
why in the reply when you close a finding as out of scope.

Nothing else is needed to merge. Once the checks on the head are green and every conversation is
resolved, GitHub merges. A draft or `no-review` pull request is never reviewed, so `Goby Review`
never reports for it and the required check never clears — those are merged by hand with an admin
override, and that is the only case where a merge bypasses a review.
