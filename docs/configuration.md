# Configuration

Everything is an environment variable, because the only caller is a workflow. The two local
scripts take flags that override the same values.

## The job

| variable | meaning |
|---|---|
| `GOBY_MODE` | `review` (default) or `gate` — gate rechecks eligibility only |
| `GOBY_REPO` | `owner/name` under review |
| `GOBY_PR` | pull request number |
| `GOBY_HEAD` | full commit SHA under review |
| `GOBY_BASE` | full base commit SHA; the diff is `merge-base(base, head)..head` when one exists |
| `GITHUB_TOKEN` | the workflow token; `pull-requests: write`, `statuses: write`, `contents: read` |
| `GOBY_GATE` | `on` posts the eligibility status; anything else (the default) leaves it off |

## Provider

| variable | meaning |
|---|---|
| `GOBY_PROVIDER` | `coral` (default), `anthropic` or `openai` — picks the upstream the proxy forwards to |
| `GOBY_MODEL` | model name |
| `CORALBRICKS_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | the key for that provider |

The key never reaches the reviewer. The entrypoint writes it to a root-only file, the proxy reads
it, and the agent's `models.json` holds a dummy value and a loopback base URL. One provider per run:
the proxy has one upstream.

## Bounds

The numbers live in `review/defaults.env` inside the image, so changing one there reaches every
consumer through the image tag; a workflow sets a variable only to override it for that repository.

| variable | default | meaning |
|---|---|---|
| `GOBY_MAX_ROUNDS` | 1 | reviews per pull request; a later push reuses the first one and says so in the status. Incompatible with requiring the gate: a push after the only review has no receipt to gate, so the gate is not recomputed for it |
| `GOBY_MAX_TURNS` | 50 | model turns one review may take; pi has no cap, so the emit extension counts `turn_start` and gives the reviewer budget notices at 10, 5 and 2 turns left |
| `GOBY_MAX_TOOL_CALLS` | 80 | tool calls, the backstop when a single turn does a lot of work |
| `GOBY_BASH_TIMEOUT_S` | 120 | wall clock for one shell command; a command with none can run until the job timeout |
| `GOBY_MAX_DIFF_LINES` | 10000 | larger diffs are skipped: the review says so and the gate fails closed |
| `GOBY_MAX_FINDINGS` | 30 | findings posted, highest severity first; the rest are counted in the summary |
| job `timeout-minutes` | 15 | the outer backstop |

## What the reviewer is given

- The diff, inlined in `prompt.md` after rendering.
- The repository at the head commit: a writable sandbox copy and a read-only reference, with a
  shell. It can read `CLAUDE.md`, `AGENTS.md` and any other file itself; nothing is injected on
  its behalf. Those files come from the change, so they are a prompt-injection surface — the
  review may be talked out of a finding, which the gate cannot detect.
- Open goby threads and the resolved thread history are read by the harness, not handed to the
  reviewer. They are used after it answers: a repeat inside an open thread's span is suppressed,
  and a re-derivation of a resolved thread with a similar title is withheld. The summary names
  what was withheld instead of dropping it silently.

## Repositories that need more than the default image

The reviewer image carries node, bun, python3, git and ripgrep. A project whose tests need Go, Rust
or a system library should build its own image `FROM goby-base`, add the toolchain, and point the
workflow at its digest. That also pre-bakes dependencies: the job can install packages (there is no
egress filtering), but a warm image is faster than an install on every review.

## Stable contracts

`src/identity.ts` holds the two status contexts (`Goby Review`, `Goby Gate`), the marker, the bot
logins and the version. Changing a marker orphans existing threads. Receipts in
`<!-- goby-gate {...} -->` carry the schema version, full head, base ref, SHA-256 diff digest,
completeness, agent flag, unthreaded count and expected inline ids; an older schema cannot grant
eligibility.

Path filters live in `src/core/contract.ts`; transport and retry logic in
`src/platforms/github.ts`.
