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
