# Next steps

## Current implementation

Goby is TypeScript with a bundled Node CLI. The action builds its own pinned
source using the frozen Bun lockfile; no package publication is necessary.
`gdp-wired` supplies the production gate decision, turn admission, and review
lifecycle. Nineteen laws are kernel-checked in CI.

## Before replacing Devin in production

- Land/review this revision and pin the full SHA in a sandbox repository.
- Verify the real GitHub workflow_run handoff, bot identity, thread-resolution
  recheck, status permissions, and failed/stale review cases.
- Require Goby Gate and CI in branch protection; preserve exact-head merge
  checks and any deployment dispatch needed after GITHUB_TOKEN merges.
- Compare 10–20 labelled historical API/web PR heads for missed bugs, false
  positives, latency, cost, and incomplete runs. Keep Devin until the bar is met.

## Follow-up work

- Owner decision on license (intended Apache-2.0, not granted yet).
- Owner-approved package/release publication. `package.json` is deliberately
  private until that approval; do not publish or retag automatically.
- A benchmark command and maintained labelled corpus; current differential
  fixtures prove implementation compatibility, not model quality.
- Fork-PR hardening: head-provided convention files remain prompt-injection
  inputs; choose a trusted-base context policy and test it.
- Trusted, bounded plugin interfaces for deterministic checks and extra context.
- Additional forge publishers and reviewer identities.

## Verify a change

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
node dist/cli.js review --pr <number> --dry-run --agent
```

Never execute code from the PR in the trusted reviewer. Change policy laws
with policy behavior; retain unsafe mutants as regressions. See
`docs/merge-gate.md`, `docs/trust-model.md`, and `CONTRIBUTING.md`.
