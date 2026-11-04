# Quickstart

## Build trusted source

```sh
git clone https://github.com/Coral-Bricks-AI/goby.git
cd goby
bun install --frozen-lockfile --ignore-scripts
bun run build
git rev-parse HEAD  # record this reviewed revision's full SHA
```

The bundle runs on Node 20+. Bun is needed for source builds, not for running
the finished CLI. `bun link` optionally exposes the local `goby` command.
From your target repository, copy the workflow template and pin it:

```sh
cp /path/to/goby/examples/workflows/goby-review.yml .github/workflows/
# replace <GOBY_COMMIT_SHA> with the full commit you reviewed
git ls-remote https://github.com/Coral-Bricks-AI/goby.git refs/heads/main
```

Add the `CORALBRICKS_API_KEY` repository secret and commit the workflow. For the OpenAI
provider, change `provider:` to `openai` and use `OPENAI_API_KEY` instead. No PyPI upload,
npm publication, or `v1` tag is required.

Upgrading is a one-line edit to the SHA. A tag would be a movable handle over executable code,
which is why the pin is a commit.

The action installs pinned build dependencies from its lockfile and builds
its own trusted revision. Never add a checkout of the PR or install PR
dependencies. The copied workflow handles same-repository PRs only;
see the [trust model](trust-model.md) for forks.

## Two statuses

- **Goby Review**: execution telemetry. Success does not imply no bugs.
- **Goby Gate**: fail-closed eligibility for the exact head, requiring a
  complete agentic review bound to the head/base/diff, successful latest execution, accounted-for
  finding threads, no open findings, and complete GitHub data.

Require **Goby Gate** and CI in branch protection. The action fails on a
blocked gate by default. `fail-on-blocked: "false"` makes only the review job
advisory; it does not turn a blocked gate green. `mode: gate` always fails closed.

## Review and refresh

```sh
export CORALBRICKS_API_KEY=... GITHUB_TOKEN=...
bun run scripts/replay.ts --diff change.diff --repo owner/name --head-sha <sha>
bun run scripts/gate.ts --pr 123 --expected-head <full-pr-head-sha>
```

The gate needs no model key or call. It rechecks existing evidence and thread resolution;
deleted threads are not resolutions. budget-exhausted/truncated reviews are
retried on the next review run without that flag.

Exit codes: `review` preserves execution-only success unless
`--fail-on-blocked` is set. With that flag, 2 means blocked and 1 means error.
`gate` returns 0/2/1 for pass/block/error. Dry-run never writes GitHub state.

Use the [workflow_run handoff](merge-gate.md), not a `status` trigger, when
using the default GitHub token. Neither the action nor the handoff merges code.

## Historical comparison

```sh
bun run scripts/replay.ts --diff change.diff --repo owner/name --head-sha <sha> --pr-hint 123
```

With `GITHUB_TOKEN`, tools and context read the pinned revision. PR intent is
the description as it stands now. Keep those inputs fixed when comparing
models. Without `--agent`, the local diff-only path uses one chat completion
and does not satisfy the merge gate's code-reading requirement.
