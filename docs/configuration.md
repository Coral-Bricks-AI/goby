# Configuration

CLI flags override environment values; environment values override provider
defaults. `goby` below means the linked CLI or `node /path/to/dist/cli.js`.

## Provider

| flag | environment | meaning |
|---|---|---|
| `--provider` | `GOBY_PROVIDER` | `coral` (default) or `openai` |
| `--model` | `GOBY_MODEL` | model name; otherwise provider default |
| `--base-url` | `GOBY_BASE_URL` | override endpoint |
| `--api-key-file` | — | `API_KEY=...` file; default `~/.config/goby/api_key` |

Key lookup: `GOBY_API_KEY`, then the provider's variable
(`CORALBRICKS_API_KEY` or `OPENAI_API_KEY`), then the key file. `doctor`
prints the source, never the key value. Agent mode requires Responses API;
the one-turn path speaks chat completions. Providers live in
`src/providers/index.ts`.

For zero-retention accounts, a structured HTTP 400 rejecting
`previous_response_id` with `unsupported_parameter` switches the agent to
client-owned conversation history. The rejected turn is retried once with the
original prompt, prior assistant items, and tool results; subsequent turns
remain stateless. The same turn cap and remaining wall deadline apply. Other
errors are not treated as permission to retry, and already-run tools are not
executed again.

## Review

| flag | environment | default |
|---|---|---|
| `--agent` | — | off locally; on in action |
| `--max-tool-turns` | `GOBY_MAX_TOOL_TURNS` | 10 locally; 25 in action |
| `--agent-wall-timeout` | `GOBY_WALL_TIMEOUT` | 600 seconds locally; 1200 in action |
| `--max-diff-lines` | — | 10000 |
| `--max-findings` | — | 30 |
| `--timeout` | — | 300 seconds per model call |
| `--expected-head` | — | unset; refuse stale workflow heads when set |
| `--fail-on-blocked` | — | off locally; on in action |
| `--force` | — | off; bypass completed-head reuse |

The runtime executes gdp-wired turn admission: up to the configured regular
turns, followed by at most one forced final turn. Budget exhaustion and
parseable output truncation can preserve useful findings but fail the gate.
Oversized diffs skip the model and fail the gate. Malformed answers are errors.

## GitHub and replay

`--repo` defaults to `GITHUB_REPOSITORY`, then the git origin. `--token`
defaults to `GITHUB_TOKEN`. `--pr` reviews a live PR. `--diff-file` requires
`--dry-run`; `--head-sha` and `--pr-hint` are replay-only flags. `--dry-run`
never posts. `--output-file` writes JSON for review or gate commands.

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
Python flag/name compatibility; exotic Python constructs are not guaranteed.
