# goby tide

The scheduled sweep. Once a day — or an hour, or a week; the workflow's `cron` is yours to
choose — it measures the default branch, picks the smells over a threshold, and files **one
issue per smell** with a plan to remove it.

Not a linter and not a bug hunt: a tide finds code that has become hard to work in — a file that
outgrew 800 lines, a directory that became a dumping ground, a module with forty imports — and
writes down how to take it apart, **without changing behaviour**. The issue reads like a
maintainer's note, and the sweep has already tried the refactor in a container with the project's
own tests around it.

## What it does, in order

1. **Measure.** `detect.py` counts, in the checkout, with no model and no parsing:

   | check | what it counts |
   |---|---|
   | `max_file_lines` | lines in a file (source limit, and a separate limit for test paths) |
   | `max_dir_files` | files directly inside a directory |
   | `max_file_imports` | import lines in a file |
   | `max_todos` | `TODO`/`FIXME`/`HACK`/`XXX` written in a comment |
   | `todo_age` | days since the oldest of those markers was committed |

   Every count is exact. `todo_age` needs history, so the clone fetches `TIDE_HISTORY_DEPTH`
   commits (default 200); if that is 1, the check is skipped and the log says so rather than
   reporting "0 days" for debt older than the window.
2. **Pick.** The worst offenders first, up to `TIDE_MAX_ITEMS` model calls, rotating between
   sweeps so a repository with forty smells hears about all of them eventually.
3. **Plan.** One agent run per candidate: it reads the file, writes the split plan, attempts the
   refactor in a sandbox copy, runs the project's suite before and after, and reports through a
   tool that refuses a proposal with no runs behind it (or no reason for having none).
4. **File.** One issue per proposal, labelled `goby-tide` and `goby`. The diff the agent left in
   the sandbox is attached by the harness — not pasted by the model — folded away so the plan is
   what a reader sees first, and labelled with whether that state is the one the after-run tested.
   The measurement in the title is the detector's.

Nothing is opened as a pull request. The issue is the deliverable; a human or another agent
takes it from there.

## Install

Copy the workflow and add the model key:

```sh
cp goby/.github/workflows/tide-scheduled.yml .github/workflows/
```

Then set the cadence in *that file* — it is the one thing a consumer owns, because a schedule is
a repository's decision, not an image's:

```yaml
on:
  schedule:
    - cron: "0 6 * * *"   # 06:00 UTC daily
```

Add `CORALBRICKS_API_KEY` as a repository secret. That is the whole install: no registry of
components, no config file required, no extra credentials. The key is read by the entrypoint and
held by a loopback proxy; the agent gets a dummy credential, so code the sweep runs cannot read
the real one.

Run it by hand whenever you like: **Actions → Goby tide → Run workflow**. The dispatch form
mirrors every input the reusable workflow takes, so a manual run can pin an image digest, a model
or a budget without touching the schedule.

Four things about `schedule` that surprise people, all of them GitHub's rather than ours:

- the cron is **UTC** and best-effort — runs are delayed at busy times and occasionally dropped,
  so treat the time as "about then", not "exactly then";
- a scheduled workflow only fires on the **default branch**;
- GitHub **disables it after 60 days of repository inactivity** (a push re-enables it);
- `on.schedule` cannot read inputs, which is why the cadence is in the workflow and every other
  knob is in the image.

## Configuration

The numbers live in the image (`tide/defaults.env`) and reach every consumer through `:latest`.
A workflow input overrides one for that repository.

| input | default | meaning |
|---|---|---|
| `max-file-lines` | 800 | a source file longer than this is a smell |
| `max-test-file-lines` | 1500 | a test file gets its own limit: splitting a table of cases buys less than splitting a module with logic in it |
| `max-dir-files` | 30 | a directory holding more files than this is a smell |
| `max-file-imports` | 40 | a file importing more than this is a smell |
| `max-todos` | 10 | debt markers in one file before it is a smell |
| `max-todo-age-days` | 365 | oldest debt marker worth filing |
| `history-depth` | 200 | commits fetched; below 2, `todo_age` is skipped and logged |
| `max-items` | 3 | agent runs one sweep may spend on smells |
| `max-tools` | 120 | tool calls one agent run may make |
| `bash-timeout-s` | 1200 | wall clock for one shell command in one scan; a command with none can run until the job timeout |
| `issues-per-day` | 5 | issues this repository may receive from the tide in 24h |
| `model` / `fallback-model` | `coral/deepseek-v4.1-flash-fast` | provider and model |
| `label` | `goby-tide` | label to file under, *and* the one dedupe reads |
| `image` | `ghcr.io/coral-bricks-ai/goby-tide:latest` | pin a `@sha256:` digest to freeze it |
| `runs-on` | `ubuntu-latest` | `[self-hosted, linux]` for a private network |

### Labels

Every issue carries two: the product's own (`goby-tide`) and the general `goby`. So
`label:goby` lists everything goby filed in a repository — reviews, cleaners, tides — and
`label:goby-tide` lists only the scheduled ones. Cleaners issues are `goby-cleaners` + `goby`, plus
the `Severity:high|medium|low` label the cleaner files under; a tide carries no severity, because
the threshold is the filter (see `post_issues.py`).

### `.goby/tide.json` (optional)

The one file a repository may commit, for the two things only it knows:

```json
{
  "ignore": ["generated/**", "db/migrations/**"],
  "known": [
    { "check": "max_file_lines", "path": "src/legacy/parser.ts",
      "reason": "hand-written table; splitting it hides the grammar" }
  ]
}
```

- **`ignore`** — paths or globs never measured. Adds to a built-in list of generated, vendored,
  minified and lock files.
- **`known`** — smells a human looked at and decided to live with. `reason` is required and is
  what the next person reads. A `known` entry stops being filed. When one stops firing, the run
  logs it, so the list cannot quietly outlive its reason.

`known` entries are the tide's answer to "this is fine, and here is why" — the same role
`INVARIANTS.md`'s *Known non-findings* plays for the cleaner.

## Duplicates, and why a closed issue is not a duplicate

A tide re-measures the same tree forever, so its dedupe is deliberately different from the
cleaner's:

- the fingerprint is `check + path` — the detector's own identity, with no sentence a model wrote
  in it, so the same 1,432-line file is the same fingerprint in March and in October;
- **an open issue, or one closed as `not planned`, suppresses the same check on the same path.**
  The two close reasons mean opposite things: `completed` says the smell was dealt with, so a file
  that later grows back past the threshold is a new finding with the closed issue as the record
  that it was fixed once; `not planned` says a human decided not to act, and asking every sweep is
  noise. The cleaner reads closed issues too, for the same reason — a decision should not be
  re-asked — but it cannot tell the two reasons apart, which this can.
- **`known` beats a close.** A `not planned` close cannot be taken back (the issue has to be
  deleted to un-mute the path), while a `known` entry carries a reason, lives in the config, and
  can be removed when the measurement starts to matter again. The footer of every issue says so.
- when a sweep can measure the whole repository and finds the smell gone, it closes the open
  issue with the measurement that replaced it. A partial sweep never closes anything.

## What it will not do

- **Change behaviour.** The refactor must leave the suite in the same state. A defect spotted on
  the way is not filed here; that is a review or a cleaner's job.
- **Replace a linter.** Deterministic, threshold-shaped smells only. Nesting depth, duplication
  and function length need a parser and a language server per repository, so they belong in a
  per-repository image, not in a sweep whose premise is "works everywhere with no setup". A
  marker is counted only where it is written — after a comment delimiter — because `L.TODO` is a
  constant in one real repository, twenty times in one file, and none of them is debt.
- **Read a private network.** On a GitHub-hosted runner it sees the repository and nothing else.
  Set `runs-on` to a self-hosted runner for a scan that reaches your network.

## From another workflow

```yaml
jobs:
  tide:
    uses: Coral-Bricks-AI/goby/.github/workflows/tide-scheduled.yml@<full sha>
    with:
      max-items: 2
    secrets:
      CORALBRICKS_API_KEY: ${{ secrets.CORALBRICKS_API_KEY }}
```

That pattern is also how to run a sweep more often than `schedule` allows, or from another
repository's clock.

## Run it locally

```sh
docker build -t goby-base goby/base
docker build -t goby-tide --build-arg BASE_IMAGE=goby-base -f goby/tide/Dockerfile goby
docker run --rm -e REPO=owner/name -e SHA=$(git rev-parse HEAD) \
  -e GITHUB_TOKEN -e CORALBRICKS_API_KEY goby-tide
```

Requires `contents: read`, `issues: write` and `packages: read` — the same scopes the workflow
declares.
