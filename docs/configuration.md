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

| variable | default | meaning |
|---|---|---|
| `GOBY_MAX_TOOL_CALLS` | 80 | tool calls one review may make; enforced in the emit extension, not the prompt |
| `GOBY_MAX_DIFF_LINES` | 10000 | larger diffs are skipped: the review says so and the gate fails closed |
| `GOBY_MAX_FINDINGS` | 30 | findings posted, highest severity first; the rest are counted in the summary |
| job `timeout-minutes` | 30 | the outer backstop |

## What the reviewer is given

- The diff, inlined in `prompt.md` after rendering.
- `CLAUDE.md` and `AGENTS.md` from the head commit (20 000 chars each), when present. These come
  from the change itself and are therefore a prompt-injection surface — the review may be talked
  out of a finding, which the gate cannot detect.
- The PR title and body (4 000 chars), labelled as intent so the stated purpose is not reported as
  a bug.
- Every open goby thread on the PR, with its span: a repeat at the same place is suppressed before
  it reaches the review.
- The resolved threads, newest 40, with the text that resolved them: a re-derivation at the same
  span with a similar title is withheld and listed in the summary instead of posted.

## Repositories that need more than the default image

The reviewer image carries node, bun, python3, git and ripgrep. A project whose tests need Go, Rust
or a system library should build its own image `FROM goby-base`, add the toolchain, and point the
workflow at its digest. That also pre-bakes dependencies: the job can install packages (there is no
egress filtering), but a warm image is faster than an install on every review.

## Stable contracts

`src/identity.ts` holds the two status contexts (`Goby Review`, `Goby Gate`), the marker, the bot
logins and the version. Changing a marker orphans existing threads. Receipts in
`<!-- goby-gate {...} -->` carry the schema version, full head, base ref, SHA-256 diff digest,
completeness, mode, unthreaded count and expected inline ids; an older schema cannot grant
eligibility.

Path filters live in `src/core/contract.ts`; transport and retry logic in
`src/platforms/github.ts`.
