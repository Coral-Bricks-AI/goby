# goby wake

The observability API. It reads what the other three products already left in GitHub — reviews and
their threads, the labelled issues the cleaners and the tide filed, and the workflow runs that
produced them — and prints one JSON object to stdout.

It stores nothing. There is no database, no artefact, no service, and no second copy of anything
GitHub already keeps. Run it twice over the same window and you get the same records. What a
consumer draws with them is the consumer's decision; this exists so that decision does not start
with parsing a log.

## Install

Copy one file and edit the `cron` line:

```sh
cp goby/wake/workflow.yml .github/workflows/goby-wake.yml
```

No secret is needed. The job reads with the repository's own `GITHUB_TOKEN`, scoped read-only by
the `permissions:` block in that file. Point whatever consumes it at the job's stdout.

Two knobs belong to the repository, and both are repository variables so they do not need the file
edited: `GOBY_WAKE_DAYS` (default 30) and `GOBY_WAKE_LIMIT` (default 500 records of each kind).

## What it reads

| source | what it gives | how long it lives |
|---|---|---|
| review bodies and review threads | findings, severity, whether the thread was resolved, the run's own numbers | forever |
| labelled issues | filed, fixed, dismissed as not planned, still open, age | forever |
| workflow runs | that a scan ran, whether it succeeded, how long it took | GitHub's retention, about 90 days |

A workflow counts as a product run when its `name:` starts with `Goby` and the product — which is
what every shipped file calls itself. Anything else, including the repository's own build and test
workflows, has `product: null`: a run attributed to the wrong product is a measurement nobody can
correct afterwards, so a renamed workflow is reported as unknown rather than guessed.

The first two are permanent, so outcome questions ("what share of findings were acted on", "how
old is the cleaners backlog") can be asked over the whole history. The third is a rolling window,
which is what a coverage or speed graph over the last quarter is anyway.

### The run marker

The reviewer's numbers — cost, tokens, turns, the model-versus-tools split, per-request latency,
timeouts — used to exist only in the Actions job summary, which has no API and expires with the
log. Every review now carries them as one hidden comment in its body:

```
<!-- goby-run {"schema":1,"product":"review","v":"0.4.0","complete":true, …} -->
```

About a kilobyte, invisible when the review is rendered, and permanent. Reviews posted before that
marker existed have `run: null` and still name their version from the review's own marker, so a
timeline does not start over at the upgrade.

Two fields are worth knowing about:

- `complete` — whether the scan finished. A review cut short by its budget is fast for the wrong
  reason, and an average over durations that mixes the two reports a system that improved when it
  started giving up sooner.
- `measured` — false when the run produced no event stream. The numbers are then absent, not zero:
  a stated zero is a measurement, and a wrong one costs more than an absent field.

## What a finding's outcome means

For each finding goby posted, the thread says what became of it:

| the thread | `outcome` |
|---|---|
| resolved | `acted_on` |
| resolved, and a reply names a commit | `acted_on`, with `fix` |
| a reply argues back, thread still open | `disputed` |
| open, no reply, line unchanged | `ignored` |
| the line was rewritten underneath it | `superseded` |

`disputed` is its own bucket and not a false positive: the person replying "out of scope" wrote the
change, and is not a neutral judge. Counting their answer as proof the finding was wrong flatters
the number that somebody would then put on a dashboard.

This is precision, by design: it classifies the findings goby **posted**. It says nothing about
what goby missed, and nothing here can.

## The output

```json
{
  "schema": 1, "product": "wake", "v": "0.4.0", "generated_at": "…", "repo": "owner/name",
  "window": { "since": "2026-09-16T00:00:00Z", "days": 30 },
  "counts": { "reviews": 12, "findings": 5, "issues": 3, "runs": 40 },
  "reviews": [ { "kind": "review", "pr": 7, "head": "…", "at": "…", "v": "0.4.0",
                 "findings": [ { "path": "a.ts", "line": 12, "severity": "high",
                                 "outcome": "acted_on" } ],
                 "run": { … }, "threads_complete": true } ],
  "issues": [ { "kind": "issue", "number": 9, "product": "goby-cleaners", "state": "closed",
                "state_reason": "not_planned", "age_days": 12, … } ],
  "runs":   [ { "kind": "run", "product": "review", "conclusion": "success", "duration_s": 150 } ],
  "hints":  [ "cost per review: reviews[].run.cost.cents, split by reviews[].at", … ],
  "notes":  []
}
```

One record per run, per issue, per workflow run — never a total. Grouping is the consumer's job,
which is what keeps a new question from needing a new release of goby.

`hints` names a handful of groupings worth starting with, in plain English and in terms of the
fields above. It is not a query language; it is there so nobody has to read this file to begin.

`notes` is the honesty channel. An empty list means the window is the whole window. Anything the
read could not see — a thread list that came back partial, a cap that bit, a source that failed —
is named there, because a graph drawn over a silently truncated list is worse than no graph.

`threads_complete: false` on a review means its findings are a floor, not a count.

## Size

About 700 bytes per review without findings, and under two kilobytes with a dozen. A busy
repository over 30 days is a few hundred kilobytes, most of it the workflow-run list. The window
and the cap are the two levers, and both are inputs.

## Versions on the x-axis

Every record names the version that produced it, and one git tag describes all three products (a
tag names a commit; every commit carries all of them). So a view can put release tags on the axis
instead of commit shas, which is what makes "did the newer goby get faster" a question with an
answer.

## Not in scope

Storing records. Rendering anything. A GitHub App. Scraping logs. Measuring recall. Reading more
than one repository per invocation — a caller whose token covers several can run it several times.
