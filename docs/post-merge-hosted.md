# Post-merge scanning on a GitHub-hosted runner

The zero-infra tier: a push to `main`, one issue per defect that could be reproduced and shown
to disappear after changing the blamed line. Nothing to deploy, no GitHub App, no cloud
account.

**What it cannot do:** reach a private network. A scan sees the repository and nothing behind
your firewall — no private database, no internal service. For that, see
[self-hosted](post-merge-self-hosted.md); the workflow is otherwise identical.

## 1. The workflow

Copy [`cleaners-post-merge.yml`](../.github/workflows/cleaners-post-merge.yml) to
`.github/workflows/` in your repo. It already runs on `push` to `main`.

Copy, rather than `uses:` the reusable workflow: calling it across repositories is what
`workflow_call` is for, but some organizations restrict it, and the failure is a run that ends in
`startup_failure` before any job is scheduled — with nothing in the log to explain it. If your
`uses:` call dies like that, copy the file; it is the same four lines.

## 2. The model key

Settings → Secrets and variables → Actions → `CORALBRICKS_API_KEY`. Any provider works — set
`model:` and the matching secret to use `anthropic/…` or `openai/…` instead.

## 3. The briefs

A scan only looks where a `CLEANER.md` file exists. Ask your agent to write them:
`/create-cleaner-md` (see [`skills/create-cleaner-md`](../skills/create-cleaner-md/SKILL.md)), review
the PR it opens, merge it. Start with three directories that carry real behaviour.

## Check it worked

Push a commit touching a directory with a `CLEANER.md`. The run's job summary shows one line per
scan — model, turns, tool calls, wall time, findings, price. A run that ends `done (clean)`
found nothing, which is the usual result.

## Knobs

`image` (pin by `@sha256:…`), `model`, `fallback-model`, `max-tools`, `issues-per-day`,
`max-components`, `tools`, `extensions`, `tool-key-env`. Defaults are in the workflow; details
in [`cleaners/README.md`](../cleaners/README.md).

## Cost

A scan is a few hundred thousand tokens and a couple of minutes; the price line in the summary
is the number to watch. GitHub-hosted minutes are billed by your plan.
