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

   The harness can read the sandbox, not what ran against it, so the diff is labelled with the
   one thing it cannot see: `report_proposal` requires `final_state_tested` when `applied` is
   true, and an issue whose sandbox changed after the after-run says so instead of calling the
   attachment tested. The claim and the diff are never folded together.

2. **A proposal without evidence says so.** `report_proposal` requires `tests_command`,
   `tests_output_before` and `tests_output_after` when `applied` is true, and a non-empty
   `unverified_reason` when it is false — in the tool's own `execute`, not in the prompt. An
   issue that claims verification it does not have is worse than one that admits the plan is
   untried. The same applies to the change: `final_state_tested: false` requires an
   `untested_changes` reason, because a diff larger than the tested one is a proposal, not a
   verified refactor.

3. **A smell is filed at most once, and the two close reasons are not the same.** The fingerprint
   is `check|path` — no model wording, so a re-titled report of the same file is the same
   fingerprint. An **open** issue suppresses, and so does one closed as **`not planned`**: that is
   a human decision not to act, and re-asking it every sweep is the noise this product exists to
   avoid. A **`completed`** close does not suppress, because code grows back — a file split today
   and passed again next year is a new finding, and the closed issue is the record that it was
   fixed once. A `not planned` close is permanent for that path, so `known` is the better answer
   and every issue says so.

4. **Nothing is closed by a sweep that did not measure the whole tree, and the measurement is
   every measurement.** `--close-gone` is passed only when `detect.py` succeeded, and the file it
   reads (the `--out` of `detect.py`) holds every candidate, never the `max_items` subset: a smell
   over today's model budget is still a smell, and closing it would put a "resolved" comment on a
   file nobody touched. What decides "gone" is the measurement, never the model — a failed agent
   run costs a proposal, not a candidate. A failed *detection* is the opposite: it knows nothing,
   and closing on it would turn the sweep's own blindness into a "resolved" comment.

5. **Every check is exact, and one that cannot be made is skipped loudly.** No check may need a
   parser or a language model to be right: a measurement whose premise is a heuristic turns a
   scheduled sweep into a source of wrong issues. `todo_age` is the one check that depends on
   something outside the tree — git history — so a one-commit clone skips it and says so in the
   plan, rather than blaming every line to the head and reporting `0 days`.

6. **A failed measurement is never a clean sweep.** A detector that cannot read the tree exits
   non-zero and the task fails; a model call that failed is visible only through
   `summarize_run.py --status` (pi exits 0 on a 401). A sweep that filed nothing while any scan
   failed exits non-zero, so silence is never indistinguishable from "no smells".

7. **The agent cannot reach a credential, and the sweep cannot reach the network it was not
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
- `COMMENT_MARKER` needs the marker to follow a comment delimiter, which is not a parser: a
  `"// TODO"` inside a string counts, and a marker written mid-block-comment without a `*` prefix
  does not. Both are accepted, because the agent reads the line anyway and a wrong *measurement*
  is the failure this check exists to avoid.
- `todo_age` measures within the fetched window (`TIDE_HISTORY_DEPTH`). A marker older than the
  window is attributed to the boundary commit, so its age is capped — too *young*, never too old.
- `detect.py` counts import *lines*, not imports. The number is a hint that the module is doing
  too much, not a module graph, and a multi-line import counts once per line it spans.
- `max_dir_files` skips the repository root: at the root the count is config files as often as
  it is source, and a sweep that files "you have 31 files at the top level" gets uninstalled.
- `BUILT_IN_IGNORE` deliberately ships without `*.md`, `*_test.*` and `*.sql`: a 1,400-line
  README, an oversized test module and a schema dump are all real smells. A repository that
  disagrees ignores them in `.goby/tide.json`.
