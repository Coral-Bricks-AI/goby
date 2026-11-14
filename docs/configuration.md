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
and the agent's `models.json` holds a dummy value and a loopback base URL. The cleaners and the tide
use the same arrangement (`base/lib.sh`) and the same file, `base/models/models.json`. One provider
per run: the proxy has one upstream.

### Reasoning

`deepseek-v4.1-flash-fast` is declared `"reasoning": true` in `base/models/models.json`, and that
flag is load-bearing rather than descriptive. pi only sends `reasoning: {effort, summary}` and
`include: ["reasoning.encrypted_content"]` for a model it has been told supports thinking
(`pi-ai/dist/api/openai-responses.js:284`), and the gateway withholds reasoning text from a client
that did not ask for it. Without the flag the model thinks, is billed for it, and the stream carries
nothing a reviewer can read — measured on four reviews that spent 80–90% of their output on thinking
nobody could see.

The level is pi's own default (`medium`, from pi's settings), so no command line needs to change,
and it reaches the gateway as effort `medium`. `--thinking <level>` overrides it per run, and
`thinkingLevelMap` decides what each level becomes. Every level is declared, including the two that
have no obvious counterpart: `xhigh` is sent as `max` (there is no `xhigh` effort, and `max` is the
nearest supported level above `high` — pi would clamp it there anyway, since it scans *forward*
first, so declaring it keeps the doc and the wire in agreement) . Measured against the gateway on
2026-11-10, one request per level on one prompt:

| effort | reasoning tokens | thinking characters |
|---|---|---|
| none | 0 | 0 |
| minimal | 371 | 1430 |
| low | 407 | 1551 |
| medium | 554 | 2234 |
| high | 1033 | 3999 |
| max | 1549 | 6173 |

Read the ends rather than the steps: adjacent levels sit inside the model's own run-to-run variance
(the same prompt twice gave 1205 and 716 thinking characters at one level). CoralBricks' client
metadata marks `minimal` and `medium` unsupported and `docs/INTEGRATIONS.md` lists `low, high, max`,
while the gateway honours all of them — so the catalog passes them through rather than
second-guessing the vendor, and `max` is open because it demonstrably does more than `high`.

Choosing the default is a speed/depth decision, not a correctness one: `medium` is what runs today,
and the table is what moving it buys or costs.

`compat.supportsDeveloperRole: false` sits beside the flag on purpose. Turning reasoning on also
flips pi's instruction role from `system` to `developer` (`openai-responses-shared.js:169`); the
gateway translates that back (`api/responses_translate.py:393`), so it would work — but then a
review would be changing two things about its request at once, and the numbers could not say which
mattered. The prompt stays a `system` message, and the reasoning opt-in is the only difference.

What to expect on the next review: thinking blocks in the transcript, so `content thinking=…` finally
carries the deliberation itself, and — worth watching — reasoning is
replayed on later turns, so `cache-read` per turn may grow. If it grows more than the visibility is
worth, `--thinking low` is the dial.

## Bounds

The seven `GOBY_*` bounds below default from `review/defaults.env` inside the image, so changing one
there reaches every consumer through the image tag; a workflow sets a variable only to override it
for that repository.

| variable | meaning |
|---|---|
| `GOBY_MAX_ROUNDS` | reviews per pull request; a later push reuses the first one and says so in the status. Incompatible with requiring the gate: a push after the only review has no receipt to gate, so the gate is not recomputed for it |
| `GOBY_MAX_TURNS` | model turns one review may take; pi has no cap, so the emit extension counts `turn_start` and gives the reviewer budget notices at 10, 5 and 2 turns left |
| `GOBY_MAX_TOOL_CALLS` | tool calls, the backstop when a single turn does a lot of work |
| `GOBY_AGENT_TIMEOUT_S` | wall clock for the agent, enforced by `timeout` as pi's parent; a turn budget is not a clock, and without this a slow provider window reaches the job timeout with the review unfinished and its statuses pending |
| `GOBY_BASH_TIMEOUT_S` | wall clock for one shell command; a command with none can run until the job timeout |
| `GOBY_MAX_DIFF_LINES` | larger diffs are skipped: the review says so and the gate fails closed |
| `GOBY_MAX_FINDINGS` | findings posted, highest severity first; the rest are counted in the summary |
| job `timeout-minutes` | the outer backstop, set in the workflow. It has to stay above `GOBY_AGENT_TIMEOUT_S` plus the clone and publish around it: a job the runner stops runs no further step, so nothing would resolve the statuses `prepare` posted |

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
  tokens in=31k out=48k cache-read=1.2M cache-write=9k reasoning=20k answer=28k \
  content thinking=69k ch, toolCall=25k ch, text=1k ch (3.5 ch/thinking tok) \
  slowest: "uv run pytest tests/x -q" 60.0s, "rg -n reauth" 3.1s
```

- `model` is the sum of the requests pi timed — **measured, never subtracted** from the agent's clock.
  pi stamps `durationMs` on every assistant message: a monotonic clock from the request starting to
  the response ending. `requests`, `p50`, `p95`, `max` are that same time cut per response. A slow
  request that wrote a lot of tokens is throughput; one that wrote little is latency, so the slowest
  turn is named with its output size. Percentiles are nearest-rank, so every number printed is one
  pi observed.
- `other=+2.4s` is what is left of the agent's wall clock, and it is printed only when it is large.
  It is *not* "tool time": pi runs a turn's tool calls concurrently, so the `tools=` sum below can
  exceed the wall clock they occupied. Leaving the remainder unnamed is the point — it is some mix
  of tool wall time, pi's startup and the sandbox copy, and this line does not pretend to split it.
- `requests=41/43` means pi did not time every response (it leaves `durationMs` off a response it
  did not see start, such as a deferred result); the distribution is over the timed ones, the gap is
  shown rather than filled with zeros, and `model>=Ns` marks the total as a lower bound.
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
- `reasoning` and `answer` split `out` with **no approximation**: `usage.reasoning` is the
  provider's own count and a documented subset of `output`, so `answer` is one count minus another.
  27.5k out = 20k reasoning + 7.5k answer is a measurement on both sides. Only a **positive** count
  is published: pi writes `output_tokens_details?.reasoning_tokens || 0`, so "not reported" and
  "none" arrive as the same number, and `reasoning=` is absent below the two fields rather than
  claiming the model did not think.
- `content` counts **characters**, because characters are what the stream carries. There is no
  tokenizer in the review image, and an earlier version divided characters by four and published the
  remainder as "not in content" — arithmetic on a real run showed that remainder was nothing but the
  divisor (94,800 characters of a 27,500-token response is 3.45 characters per token, not 4), so the
  number was a claim about our constant rather than about the model.
- `ch/thinking tok` is the one place those two units meet, and it is a diagnostic: text runs at
  roughly 3–4 characters per token, so **twice that means the same text arrived twice**. The gateway
  repeats the raw reasoning on its summary channel when `reasoning.summary` is set, and pi appends
  both channels into one thinking block; it matters because that text is replayed upstream on later
  turns. `duplicated?` is printed above 6.

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

### When a review does not answer

Two deadlines, in the order they fire:

- `GOBY_AGENT_TIMEOUT_S` is `timeout` wrapped around pi inside the agent's own process tree. It exits
  124, which the harness reads as *the reviewer spent its wall clock* rather than *the reviewer
  exited*, and either way the statuses are resolved with that reason on them.
- A SIGTERM the runner sends on its own — its `timeout-minutes`, a new push under
  `cancel-in-progress` — is caught by the cancel handler, which resolves the same statuses to
  `Review failed: the review was cancelled before it finished`. The number above is what should fire
  first; this is the second line. Without it a review killed mid-run left `Goby Review` pending on
  the head with the note still saying "is reviewing", which is a blocked pull request and nothing to
  read.

Because the deadline fires inside the review's own process, the failure is an ordinary exit: the
instrumentation still runs, so the log of a run that spent its budget carries the timing line
(`max=` against `p95=` is what tells a stalled request from uniformly slow turns), one line per tool
call, and pi's stderr tail. Nothing is uploaded — a job the runner stops runs no step at all, so an
artifact would never have covered the case the deadline exists for.

## Stable contracts

`src/identity.ts` holds the two status contexts (`Goby Review`, `Goby Gate`), the marker, the bot
logins and the version. Changing a marker orphans existing threads. Receipts in
`<!-- goby-gate {...} -->` carry the schema version, full head, base ref, SHA-256 diff digest,
completeness, agent flag, unthreaded count and expected inline ids; an older schema cannot grant
eligibility.

Reviews also carry `<!-- goby-run {...} -->`: the run's own numbers — cost, tokens, turns, the
model/tool split, per-request latency, timeouts — which otherwise existed only in the Actions job
summary, where no API reads them and the log's retention ends. `src/core/record.ts` is the grammar
and `common/runrecord.py` the writer; [`wake/README.md`](../wake/README.md) says what a reader does
with it.

Path filters live in `src/core/contract.ts`; transport and retry logic in
`src/platforms/github.ts`.
