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
- Arm auto-merge when you open a pull request: `gh pr merge <n> --auto --squash`. `main` requires
  `check` and `Goby Review` and every conversation resolved, so GitHub merges it when those are true.
  Arm it with a person's token, never a `GITHUB_TOKEN` inside CI: that merge starts no `push`
  workflows, so `:latest` would never publish and the post-merge cleaners would never scan.

## A review round, from the other side

1. Read every thread and decide whether it is worth fixing.
2. Fix it, then commit.
3. Push.
4. Reply `fixed in <short sha>`, then resolve the thread.

Push before replying: resolving releases the merge. A resolved thread is not re-reported, so resolve
only what you fixed, or reply why it is out of scope.
