# Configuration

Everything is an environment variable, because the only caller is a workflow. The two local
scripts take flags that override the same values.

This page is the **reviewer**. The other two products have their own, because they run on a
different trigger and file into a different place:

| product | configuration | trigger |
|---|---|---|
| review | this page | a pull request |
| cleaners | [`cleaners/README.md`](../cleaners/README.md) | a push to the default branch |
| tide | [`tide/README.md`](../tide/README.md) | a schedule you set in the workflow |

What they do share is one rule, and it is the reason a consumer can stay on `:latest`: the
numbers — budgets, thresholds — live in the image (`*/defaults.env`), and a workflow sets a
variable only to override one. The single exception is the tide's `cron`, which is a repository's
own decision and cannot be an input (`on.schedule` takes none).

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

The key never reaches the agent. The entrypoint writes it to a root-only file, the proxy reads it,
and the agent's `models.json` holds a dummy value and a loopback base URL. The cleaners use the
same arrangement (`base/lib.sh`). One provider per run:
the proxy has one upstream.

## Bounds

The six `GOBY_*` bounds below default from `review/defaults.env` inside the image, so changing one
there reaches every consumer through the image tag; a workflow sets a variable only to override it
for that repository.

| variable | meaning |
|---|---|
| `GOBY_MAX_ROUNDS` | reviews per pull request; a later push reuses the first one and says so in the status. Incompatible with requiring the gate: a push after the only review has no receipt to gate, so the gate is not recomputed for it |
| `GOBY_MAX_TURNS` | model turns one review may take; pi has no cap, so the emit extension counts `turn_start` and gives the reviewer budget notices at 10, 5 and 2 turns left |
| `GOBY_MAX_TOOL_CALLS` | tool calls, the backstop when a single turn does a lot of work |
| `GOBY_BASH_TIMEOUT_S` | wall clock for one shell command; a command with none can run until the job timeout |
| `GOBY_MAX_DIFF_LINES` | larger diffs are skipped: the review says so and the gate fails closed |
| `GOBY_MAX_FINDINGS` | findings posted, highest severity first; the rest are counted in the summary |
| job `timeout-minutes` | the outer backstop, set in the workflow |

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

The reviewer image carries node, python3, git, jq and ripgrep: what the harness itself runs, plus
the tools a reviewer reaches for on almost every diff. Everything else it installs for itself — the
sandbox has a shell and there is no egress filtering, so a repo whose tests need bun or git-lfs gets
them at review time. A project that would rather not pay that install on every review, or whose
tests need Go, Rust or a system library, should build its own image `FROM goby-base`, add the
toolchain, and point the workflow at its digest. That also pre-bakes dependencies: the job can
install packages, but a warm image is faster than an install on every review.

## Where a review's time goes

A review prints its phases to the job log with a UTC timestamp, so the log is the trace: `clone`,
`merge base`, `diff`, `prepare` (the GitHub reads and the image digest), and `agent exit`. What is
between two of those lines is what that phase cost.

Inside the agent there is one line more, and it is the one to read first when a review feels slow:

```
timing agent=118s model=77s requests=43 p50=1.3s p95=2.9s max=6.1s (turn 12: 890 out) \
  tools=41.1s (62 calls: bash 38.9s/44, read 1.8s/12) \
  turns=31 calls/turn=2.0 (12/31 ran 2+) timeouts=2 notices=3 \
  tokens in=31k out=48k cache-read=1.2M cache-write=9k \
  output ~40k tok (thinking 89%, toolCall 7%, text 4%) \
  slowest: "uv run pytest tests/x -q" 60.0s, "rg -n reauth" 3.1s
```

- `model` is the agent's wall clock minus the tools' own clocks — the time spent waiting on the
  provider. `requests`, `p50`, `p95`, `max` are that same time cut per response, and they are
  **measured, not derived**: pi stamps `durationMs` on every assistant message, a monotonic clock
  from the request starting to the response ending. A slow request that wrote a lot of tokens is
  throughput; one that wrote little is latency, so the slowest turn is named with its output size.
  Percentiles are nearest-rank, so every number printed is one pi observed.
- `requests=41/43` means pi did not time every response (it leaves `durationMs` off a response it
  did not see start, such as a deferred result); the distribution is over the timed ones, and the
  gap is shown rather than filled with zeros.
- `unaccounted=+2.4s` is printed only when it is large: time inside the agent that was neither a
  request pi timed nor a tool. The two are independent measurements, so a gap is a fact — small is
  pi's own startup, large means one of them is wrong and is worth reading.
- `tools` is measured by pi around each tool's own execution, so it is not an estimate. The slowest
  calls are named with the command that took the time: one killed `pytest` is not forty reads.
- `calls/turn` is how many probes shared a round trip, and `(n/m ran 2+)` how many turns ran more
  than one. It says how the reviewer spends its turns; it does **not** promise a speed-up, because a
  turn costs what its tokens cost (see below).
- `timeouts` counts shell commands killed at `GOBY_BASH_TIMEOUT_S`. A review that spent a minute at
  that wall clock is a review whose probe was cut off, which reads very differently from one that
  thought for a minute.
- `notices` is how many budget nudges the reviewer was given (at 10, 5 and 2 turns left), and
  `blocked` names the cap that cut it off, if one did. Both come from the records the emit
  extension leaves beside the findings, because the conversation a nudge is injected into is not
  kept — without them, whether a nudge fired is unknowable after the container exits.
- `tokens` is the whole run's spend, in the four classes the provider reports. Cache-read against
  input is the interesting pair: a turn that re-reads the context is the slow kind.
- `output` splits those written tokens by what the model was writing — `thinking`, `toolCall`,
  `text` — read from the final assistant messages, in characters. The shares are exact in
  characters and approximate in tokens (four characters per token), which is why the total carries
  the `~`. Where the visible tokens fall short of `out=`, the line says how much of the output is
  **not in the content at all**: a reasoning model bills thinking tokens it never streams back, and
  rounding those into "text" would invert the answer to "what is it spending time on".

Before that line the log carries one line per tool call, in order:

```
call  1 bash 0.02s cd /workspace/sandbox && grep -rn effort_from_thinking ml/infra/effort.py
call  1 read 0.01s ml/infra/effort.py
call  2 bash 0.04s cd /workspace/sandbox && sed -n '40,90p' ml/infra/effort.py
```

The same turn number on several `call` lines is one round trip; one call per turn is the shape
that costs a review its wall clock. A `!` marks a command that failed.

The line is instrumentation, never a verdict: it is printed whatever the review concluded, and
`--json` on `/opt/common/timing.py` carries every call, every response's timing, and the per-turn
histogram. What it still cannot give is time-to-first-token — pi times a whole response, so a slow
start and a slow write are one number here, and separating them would mean reading the event stream
as it arrives.

## Stable contracts

`src/identity.ts` holds the two status contexts (`Goby Review`, `Goby Gate`), the marker, the bot
logins and the version. Changing a marker orphans existing threads. Receipts in
`<!-- goby-gate {...} -->` carry the schema version, full head, base ref, SHA-256 diff digest,
completeness, agent flag, unthreaded count and expected inline ids; an older schema cannot grant
eligibility.

Path filters live in `src/core/contract.ts`; transport and retry logic in
`src/platforms/github.ts`.
