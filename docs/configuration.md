# Configuration

The action takes its configuration as inputs (`action.yml`), which reach the entrypoint as
environment variables. The two local scripts take flags, which override the same environment
values, which override provider defaults.

## Provider

| action input | script flag | environment | meaning |
|---|---|---|---|
| `provider` | `--provider` | `GOBY_PROVIDER` | `coral` (default) or `openai` |
| `model` | `--model` | `GOBY_MODEL` | model name; otherwise provider default |
| `base-url` | `--base-url` | `GOBY_BASE_URL` | override endpoint |
| — | — | `GOBY_API_KEY` | key, ahead of the provider's own variable |

Key lookup: `GOBY_API_KEY`, then the provider's variable
(`CORALBRICKS_API_KEY` or `OPENAI_API_KEY`), then `~/.config/goby/api_key`. Agent mode requires
the Responses API; the one-turn path speaks chat completions. Providers live in
`src/providers/index.ts`.

## Review

| action input | script flag | default |
|---|---|---|
| — | `--no-agent` | agent on in both; the flag turns it off for a one-turn replay |
| `max-tool-turns` | `--max-tool-turns` | 25 |
| `wall-timeout` | `--wall-timeout` | 1200 seconds |
| — | `--max-diff-lines` | 10000 |
| — | `--max-findings` | 30 |
| `expected-head` | `--expected-head` | unset; refuse stale workflow heads when set |
| `fail-on-blocked` | — | on in the action |

The runtime executes gdp-wired turn admission: up to the configured regular
turns, followed by at most one forced final turn. Budget exhaustion and
parseable output truncation can preserve useful findings but fail the gate.
Oversized diffs skip the model and fail the gate. Malformed answers are errors.

`grep` reads files in batches of 100 through one GraphQL request each, instead
of one contents request per file: a directory search that cost 200 requests now
costs 2. Per-file reads still use the contents API, and the same 1 MiB per-file
limit and read windows apply on both paths, so a review cannot depend on which
transport served a file.

## GitHub and replay

`GITHUB_REPOSITORY` defaults the repo, then the git origin; `GITHUB_TOKEN` the token. A live
review takes `pr-number` (or `--pr` for the gate). `scripts/replay.ts` takes a saved diff plus
`--head-sha` and `--pr-hint`, never posts, and writes JSON to `--out`. `scripts/gate.ts` takes
`--pr` and `--expected-head`.

`GOBY_BOT_LOGINS` is a comma-separated list of trusted authors; defaults are
`github-actions,github-actions[bot]`. A dedicated GitHub App must configure
its own login. This is an authorization boundary, not just display metadata.

## Action inputs

The source action exposes `provider`, `model`, `base-url`, `github-token`,
`pr-number`, `expected-head`, `mode` (`review` or `gate`), `fail-on-blocked`,
`max-tool-turns`, and `wall-timeout`. PR number/head default to the pull request
event; supply them explicitly for workflow_run/dispatch. There is no package
`version` input: pin the full action commit SHA.

## Stable contracts

`src/identity.ts` defines `Goby Review` (execution), `Goby Gate` (eligibility),
the `goby` marker, bot identities, and version. Changing markers can orphan
old threads. Receipts in `<!-- goby-gate {...} -->` carry schema version,
full head, base ref, SHA-256 diff digest, completeness, mode, unthreaded count,
and expected inline IDs. Older receipt schemas cannot grant eligibility.
See [merge integration](merge-gate.md) for the gate prerequisites.

Path filters are in `src/core/contract.ts`; transport/retry logic is in
`src/providers/base.ts`. JavaScript regex syntax powers grep, with common
`(?i)`/`(?m)`/`(?s)` flag and named-group compatibility.
