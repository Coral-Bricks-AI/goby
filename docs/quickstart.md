# Quickstart

## Build trusted source

```sh
git clone https://github.com/Coral-Bricks-AI/goby.git
cd goby
bun install --frozen-lockfile --ignore-scripts
bun run build
node dist/cli.js version
git rev-parse HEAD  # record this reviewed revision's full SHA
node dist/cli.js doctor --deep  # spend two real turns: tools + a resent transcript
```

The bundle runs on Node 20+. Bun is needed for source builds, not for running
the finished CLI. `bun link` optionally exposes the local `goby` command.
From your target repository:

```sh
node /path/to/goby/dist/cli.js init --ref <reviewed-full-goby-commit-sha>
node /path/to/goby/dist/cli.js init --ref v0.3.0   # tag resolves to its commit
```

A tag is only a handle: `init` and `pin` always write the full commit SHA into
the workflow. Upgrade an existing pin in place instead of hand-editing YAML:

```sh
node /path/to/goby/dist/cli.js pin --ref v0.3.1 --dry-run
node /path/to/goby/dist/cli.js pin --ref v0.3.1
```

`doctor --deep` is the live transport canary: two model turns, an exercised tool
round trip, and a hard failure unless every request was stateless
(`store: false`, no `previous_response_id`). Run it after configuring a key and
after any gateway or retention-policy change; a review that cannot run a second
turn posts nothing.

Add the `CORALBRICKS_API_KEY` repository secret and commit the generated
`.github/workflows/goby-review.yml`. `init openai --ref <sha>` uses the OpenAI
provider and its secret instead. No PyPI upload, npm publication, or `v1` tag
is required.

The action installs pinned build dependencies from its lockfile and builds
its own trusted revision. Never add a checkout of the PR or install PR
dependencies. The generated workflow handles same-repository PRs only;
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
export CORALBRICKS_API_KEY=...
export GITHUB_TOKEN=...
goby doctor
goby review --pr 123 --dry-run --agent
goby review --pr 123 --agent --fail-on-blocked
goby gate --pr 123 --expected-head <full-pr-head-sha>
```

The last command needs no model key or call. It rechecks existing evidence
and thread resolution. Deleted threads are not resolutions. `--force`
explicitly repeats a full review; budget-exhausted/truncated reviews are
retried on the next review run without that flag.

Exit codes: `review` preserves execution-only success unless
`--fail-on-blocked` is set. With that flag, 2 means blocked and 1 means error.
`gate` returns 0/2/1 for pass/block/error. Dry-run never writes GitHub state.

Use the [workflow_run handoff](merge-gate.md), not a `status` trigger, when
using the default GitHub token. Neither the action nor the handoff merges code.

## Historical comparison

```sh
goby review --diff-file change.diff --repo owner/name --head-sha <sha> \
  --pr-hint 123 --dry-run --agent
```

With `GITHUB_TOKEN`, tools and context read the pinned revision. PR intent is
the description as it stands now. Keep those inputs fixed when comparing
models. Without `--agent`, the local diff-only path uses one chat completion
and does not satisfy the merge gate's code-reading requirement.
