# Quickstart

## Install

Two files, one secret, one branch-protection rule.

```sh
# 1. the reviewer
cp goby/review/workflow.yml .github/workflows/goby-review.yml
# 2. the gate recheck (workflow_run handoff; must live on the default branch)
cp goby/examples/workflows/goby-gate.yml .github/workflows/goby-gate.yml
```

In both files, replace the image digest with the one you reviewed — `ghcr.io/coral-bricks-ai/goby-review@sha256:…`,
printed by the image build. A tag would be a movable handle over executable code.

Then:

3. Add `CORALBRICKS_API_KEY` as a repository secret. For another provider, change `GOBY_PROVIDER`
   / `GOBY_MODEL` and use that provider's secret.
4. Require **Goby Gate** and CI in branch protection — not Goby Review.

The reviewer clones the pull request and runs in a container; the gate recheck runs the same image
with no model call. Neither uses `pull_request_target`, and neither checks out anything into the
runner.

## Two statuses

- **Goby Review** — execution telemetry. Success does not imply no bugs.
- **Goby Gate** — fail-closed eligibility for the exact head: a complete review bound to
  head/base/diff, accounted finding threads, no open findings, complete GitHub data.

## Run it locally

Against a real pull request, posting nothing:

```sh
export GITHUB_TOKEN=... CORALBRICKS_API_KEY=...
docker build -t goby-base base
docker build -t goby-review -f review/Dockerfile .
docker run --rm -e GITHUB_TOKEN -e CORALBRICKS_API_KEY \
  -e GOBY_REPO=owner/name -e GOBY_PR=123 \
  -e GOBY_HEAD=$(gh pr view 123 --json headRefOid -q .headRefOid) \
  -e GOBY_BASE=$(gh pr view 123 --json baseRefOid -q .baseRefOid) \
  -e GOBY_MODEL=deepseek-v4.1-flash-fast \
  goby-review
```

Refresh the gate without a model call:

```sh
bun run scripts/gate.ts --pr 123 --expected-head <full-pr-head-sha>
```

Deleted threads are not resolutions. An incomplete review is retried on the next push, because its
receipt says so. Exit codes: gate `0` pass, `2` blocked, `1` error.

## Develop

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check   # typecheck → kernel-checked policies → Node build → offline tests
```

The tests are offline: the contract corpus, the diff and line-positioning rules, the key proxy
against a stub upstream, the publisher against a stubbed GitHub, and the gate over every Boolean
combination of its facts.
