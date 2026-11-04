# Next steps

Goby is two halves of one crew:

- **Review / Gate** — pre-merge. Reads a pull request before it merges, posts bugs on the exact
  lines, and keeps review completion separate from merge eligibility (`review/`,
  `docs/merge-gate.md`, `docs/trust-model.md`).
- **Cleaners** — post-merge. A push to `main` hunts every component the push touched, reproduces
  what it suspects, and files one issue per defect it can prove (`cleaners/`, docs under
  `docs/post-merge-*.md`).

Both are Apache-2.0. What follows is what is not finished.

## Blocking adoption

- **GHCR package visibility.** `ghcr.io/coral-bricks-ai/goby-cleaners` is private. Our own runs
  pull it because the job authenticates with `packages: read`, but a repo outside the org cannot
  pull anonymously. Change it under the package's settings → Danger Zone → visibility. The REST
  API refuses this for org packages even with `write: packages`, so it is a one-click UI action.
- **One install path is untested from outside.** Cleaners has only ever been installed on this
  repository. Install it on a repo that is not ours, from the docs alone, before calling the
  docs done — that is the only check that catches a missing input or a secret name.

## Product

- **A run the hunter cannot start must say so.** Container-job pull failures surface in the
  runner's container initialisation step, not in our log, so the run looks like a broken workflow
  file. A preflight step that prints the resolved image and digest would make the common
  first-run failure legible.
- **The price line needs a catalog.** A repo that commits no `.goby/models.json` reads `price
  unknown`. Fine by design; the docs should say what a rates file buys you *before* the first
  run, not after.
- **N hunters per push.** `HUNTER_INDEX` exists and is always 0. Parallel hunters buy recall at
  N× cost; measure before wiring.
- **A referee.** A second model that re-derives a claim, only if filed findings turn out noisy.
- **Fixers.** Read a cleaner issue, open a PR. Existing review and merge gate untouched, so no
  agent ever merges unreviewed code.
- **Lifeguard.** Prod telemetry → issue, same filing gates.

## Harness

- `entrypoint.sh` and `hunt.sh` still hold decisions that belong in tested Python; every
  control-flow bug found so far has been in one of them. See `cleaners/HUNT.md`.
- An ephemeral Postgres in the image would make queue and ledger invariants provable at all.
- Automate the `Known non-findings` list from closed issues: right now it is a hand-edited line
  per false positive.

## Review

- Owner decision on the merge gate as a required check, and on publishing the `dist/` bundle;
  `package.json` is deliberately `private` until that call.
- Fork-PR context policy: head-provided convention files are still prompt-injection inputs.
- A labelled corpus and a benchmark command; the current differential fixtures prove
  implementation compatibility, not model quality.
