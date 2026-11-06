<!--
Passed verbatim to the goby-cleaners agent as its brief for this directory: the cleaner scanning
the tide. A bug here is code that makes one of these invariants false, or false under some
reachable input.

Read "What cannot be demonstrated here" before reporting anything. Most of this directory's
failure modes are uid, container or scheduling interactions, and a claim about one of those
cannot be reproduced from inside the scan.
-->

# tide

Paths: `tide/**`

The tide files issues about code that is hard to work in, and never about code that is wrong.
Its defects therefore do not make a sweep fail — they make it **file a plan that would change
behaviour**, or **file nothing while looking like it swept**, which are the two failures the
whole design exists to prevent.

## Invariants

1. **The measurement is the detector's and the diff is the harness's.** `detect.py` decides what
   a smell is, `post_issues.py` renders its number into the title, and the refactor attachment is
   read out of the sandbox with `git diff` by `entrypoint.sh` after the agent exits. No value in
   an issue that a human checks may come from the model's prose: a title a model wrote would
   drift between sweeps, and a diff a model pasted is a diff nobody tested.

2. **A proposal without evidence says so.** `report_proposal` requires `tests_command`,
   `tests_output_before` and `tests_output_after` when `applied` is true, and a non-empty
   `unverified_reason` when it is false — in the tool's own `execute`, not in the prompt. An
   issue that claims verification it does not have is worse than one that admits the plan is
   untried.

3. **A smell is filed at most once, and a closed one does not count.** The fingerprint is
   `check|path` — no model wording, so a re-titled report of the same file is the same
   fingerprint. Dedupe reads **open** `goby-tide` issues only, because code grows back; the
   cleaner reads closed issues too, and copying that here would make every fixed-then-regrown
   smell invisible forever.

4. **Nothing is closed by a sweep that did not measure the whole tree, and the measurement is
   every measurement.** `--close-gone` is passed only when `detect.py` succeeded, and the file it
   reads (the `--out` of `detect.py`) holds every candidate, never the `max_items` subset: a smell
   over today's model budget is still a smell, and closing it would put a "resolved" comment on a
   file nobody touched. What decides "gone" is the measurement, never the model — a failed agent
   run costs a proposal, not a candidate. A failed *detection* is the opposite: it knows nothing,
   and closing on it would turn the sweep's own blindness into a "resolved" comment.

5. **A failed measurement is never a clean sweep.** A detector that cannot read the tree exits
   non-zero and the task fails; a model call that failed is visible only through
   `summarize_run.py --status` (pi exits 0 on a 401). A sweep that filed nothing while any scan
   failed exits non-zero, so silence is never indistinguishable from "no smells".

6. **The agent cannot reach a credential, and the sweep cannot reach the network it was not
   given.** The agent runs as uid 10001 under `env -i` with one provider key; the GitHub token is
   a root-only file. On a GitHub-hosted runner the sweep sees the repository and nothing else,
   and no code path may widen that without the workflow asking for a self-hosted runner.

## What cannot be demonstrated here

- **The schedule.** `on.schedule` is GitHub's; a scan cannot observe a cron firing, a delayed
  tick or the 60-day disable.
- **A model call that fails with a specific provider error.** `summarize_run.py` is testable
  against a recorded event stream; the provider is not reachable from the scan.
- **The two-label convention against the real API.** `common/issues.py` is tested with a stubbed
  `_http`; label creation returns 422 for "already exists" and no test can prove GitHub's
  behaviour, only ours.

## Known non-findings

- `collect.py` repeats `classify`'s eight-line five-case rule from `cleaners/plan.py` rather than
  importing it across products. The expensive shared thing — filing, labelling, reading the
  history — is in `common/issues.py`; the alternative here is a `sys.path` bootstrap in a module
  that does not otherwise touch GitHub.
- `detect.py` counts import *lines*, not imports. The number is a hint that the module is doing
  too much, not a module graph, and a multi-line import counts once per line it spans.
- `max_dir_files` skips the repository root: at the root the count is config files as often as
  it is source, and a sweep that files "you have 31 files at the top level" gets uninstalled.
- `BUILT_IN_IGNORE` deliberately ships without `*.md`, `*_test.*` and `*.sql`: a 1,400-line
  README, an oversized test module and a schema dump are all real smells. A repository that
  disagrees ignores them in `.goby/tide.json`.
