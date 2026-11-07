"""One source of truth for the sweep's budgets and thresholds.

The numbers used to live in a fallback, a workflow, and every vendored copy of the workflow. A
consumer on `:latest` only inherits a change if the number lives in the image, so assert that the
image owns them and the workflow passes overrides through instead of restating them.

The one deliberate exception is the schedule: a cron expression is a repository's decision, and
`on.schedule` cannot read an input, so it stays in the workflow and nowhere else.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORKFLOW = ROOT / ".github/workflows/tide-scheduled.yml"


def test_the_defaults_live_in_the_image():
    defaults = (HERE / "defaults.env").read_text()
    for name, value in (("TIDE_MAX_FILE_LINES", 800), ("TIDE_MAX_DIR_FILES", 30),
                        ("TIDE_MAX_FILE_IMPORTS", 40), ("TIDE_MAX_ITEMS", 3),
                        ("TIDE_MAX_TOOLS", 120), ("TIDE_BASH_TIMEOUT_S", 1200),
                        ("TIDE_ISSUES_PER_DAY", 5)):
        assert f': "${{{name}:={value}}}"' in defaults, name


def test_the_entrypoint_sources_the_defaults_and_never_restates_a_number():
    entrypoint = (HERE / "entrypoint.sh").read_text()
    assert "source /opt/tide/defaults.env" in entrypoint
    for name, value in (("TIDE_MAX_ITEMS", 3), ("TIDE_MAX_TOOLS", 120),
                        ("TIDE_BASH_TIMEOUT_S", 1200),
                        ("TIDE_ISSUES_PER_DAY", 5), ("TIDE_MAX_FILE_LINES", 800),
                        ("TIDE_MAX_DIR_FILES", 30), ("TIDE_MAX_FILE_IMPORTS", 40)):
        assert f'{name}="${{{name}:-{value}}}"' not in entrypoint, name
        assert f"{name}:={value}" not in entrypoint, name


def test_the_dockerfile_ships_the_defaults_and_shares_common():
    dockerfile = (HERE / "Dockerfile").read_text()
    assert "tide/defaults.env" in dockerfile
    assert "COPY tide/detect.py tide/collect.py tide/post_issues.py /opt/tide/" in dockerfile
    assert "COPY common/issues.py /opt/common/issues.py" in dockerfile
    assert "ARG BASE_IMAGE=goby-base" in dockerfile
    assert "FROM ${BASE_IMAGE}" in dockerfile, "the tide is built on goby-base, not on node"


def test_the_emit_tool_has_no_numeric_fallback():
    """A number in two places is a number that disagrees. The cap is image-owned, so a missing
    value has to fail loudly instead of quietly using 60."""
    extension = (HERE / "report_proposal.ts").read_text()
    assert 'requiredInt("TIDE_MAX_TOOLS")' in extension
    assert "?? 60" not in extension and "?? 120" not in extension
    assert 'requiredInt("TIDE_BASH_TIMEOUT_S")' in extension
    assert "?? 600" not in extension and "?? 1200" not in extension


def test_the_workflow_passes_overrides_and_does_not_restate_the_numbers():
    workflow = WORKFLOW.read_text()
    for name, value in (("TIDE_MAX_ITEMS", 3), ("TIDE_MAX_TOOLS", 120),
                        ("TIDE_BASH_TIMEOUT_S", 1200),
                        ("TIDE_ISSUES_PER_DAY", 5), ("TIDE_MAX_FILE_LINES", 800),
                        ("TIDE_MAX_DIR_FILES", 30), ("TIDE_MAX_FILE_IMPORTS", 40)):
        assert f"{name}: ${{{{ inputs." in workflow, name
        assert f":={value}" not in workflow, name
        assert f"|| {value}" not in workflow, name


def test_the_schedule_is_the_consumers_and_is_not_in_the_image():
    """A cron expression is the one thing a consumer keeps their own copy of: when a repository is
    swept is a repository's decision, and `on.schedule` cannot read an input."""
    assert "schedule:" in WORKFLOW.read_text()
    assert "cron:" in WORKFLOW.read_text()
    for shipped in (HERE / "defaults.env", HERE / "entrypoint.sh"):
        assert "cron" not in shipped.read_text(), shipped.name


def test_the_sweep_can_be_run_by_hand_and_from_another_workflow():
    workflow = WORKFLOW.read_text()
    assert "workflow_dispatch:" in workflow
    assert "workflow_call:" in workflow
    # A manual run must be able to pin what a caller could pin, or the dispatch form is a second
    # and smaller set of knobs.
    assert workflow.count("max-file-lines:") == 2
    assert "issues:" in workflow and "packages:" in workflow


def test_the_log_names_the_known_entries_it_used_and_the_stale_ones():
    """The issue sends a reader to `.goby/tide.json`; a `known` decision that is invisible in the
    log is the unexplained silence the list exists to avoid, and a stale entry is a smell hidden
    behind a reason nobody remembers writing."""
    entrypoint = (HERE / "entrypoint.sh").read_text()
    assert "suppressed by .goby/tide.json" in entrypoint
    assert "known: {candidate[\"check\"]}" in entrypoint
    assert "stale known entry, safe to delete" in entrypoint
    assert 'done < "$OUT/plan.txt"' in entrypoint


def test_the_new_checks_default_from_the_image():
    defaults = (HERE / "defaults.env").read_text()
    for name, value in (("TIDE_MAX_TEST_FILE_LINES", 1500), ("TIDE_MAX_TODOS", 10),
                        ("TIDE_MAX_TODO_AGE_DAYS", 365), ("TIDE_HISTORY_DEPTH", 200)):
        assert f': "${{{name}:={value}}}"' in defaults, name
    entrypoint = (HERE / "entrypoint.sh").read_text()
    for name, value in (("TIDE_MAX_TODOS", 10), ("TIDE_MAX_TODO_AGE_DAYS", 365),
                        ("TIDE_HISTORY_DEPTH", 200), ("TIDE_MAX_TEST_FILE_LINES", 1500)):
        assert f'{name}="${{{name}:-{value}}}"' not in entrypoint, name
    workflow = WORKFLOW.read_text()
    for name, value in (("TIDE_MAX_TODOS", 10), ("TIDE_MAX_TODO_AGE_DAYS", 365),
                        ("TIDE_HISTORY_DEPTH", 200), ("TIDE_MAX_TEST_FILE_LINES", 1500)):
        assert f"{name}: ${{{{ inputs." in workflow, name
        assert f"|| {value}" not in workflow, name


def test_the_clone_is_deep_enough_for_todo_age():
    """A one-commit clone blames every line to the head, so `todo_age` would report 0 days forever.
    Both the clone and the follow-up fetch have to use the depth, or the fetch re-shallowens it."""
    entrypoint = (HERE / "entrypoint.sh").read_text()
    assert '--depth "$TIDE_HISTORY_DEPTH"' in entrypoint
    assert entrypoint.count('--depth "$TIDE_HISTORY_DEPTH"') == 2, "clone and fetch"


def test_every_shell_command_has_a_wall_clock():
    """pi gives a bash command no timeout of its own, and the model may pass any number it likes:
    without a ceiling in the harness, one `pytest` over a monorepo or one stalled `pip install`
    runs until the job's `timeout-minutes` and the sweep files nothing from the candidates it
    already finished. The reviewer's 120 assumes a diff-sized command; the tide runs a suite."""
    entrypoint = (HERE / "entrypoint.sh").read_text()
    # The value reaches pi's own process — and only there: the agent's shell has no use for it, so
    # it stays out of the extension's environment allowlist.
    assert 'TIDE_JSON=1 TIDE_MAX_TOOLS="$TIDE_MAX_TOOLS" TIDE_BASH_TIMEOUT_S="$TIDE_BASH_TIMEOUT_S"' \
        in entrypoint
    assert "TIDE_BASH_TIMEOUT_S" in entrypoint.split("for knob in")[1].split("do")[0], \
        "0 from an empty dispatch input must fall back to the image default"
    assert "bash_timeout=${TIDE_BASH_TIMEOUT_S}s" in entrypoint, "the log says the ceiling"
    extension = (HERE / "report_proposal.ts").read_text()
    assert "createLocalBashOperations" in extension
    # A ceiling, not a default: `??` would let the model's own `timeout` be the sweep's wall clock.
    assert "Math.min(options.timeout ?? COMMAND_TIMEOUT_S, COMMAND_TIMEOUT_S)" in extension
    assert "TIDE_BASH_TIMEOUT_S" not in extension.split("ENV_ALLOW = new Set([")[1].split("]);")[0], \
        "the agent's shell does not need the knob"


def test_a_command_that_hit_the_wall_clock_is_loud():
    """pi exits 0 after a tool error, so a scan cut short by the timeout finishes like any other.
    The count comes from the run's event stream, and a scan that filed nothing was not quiet."""
    entrypoint = (HERE / "entrypoint.sh").read_text()
    assert 'summarize_run.py --timeouts "$OUT/agent/$slug/events.jsonl"' in entrypoint
    assert "hit the ${TIDE_BASH_TIMEOUT_S}s command wall" in entrypoint
    assert "produced no proposal; it was cut short, not quiet" in entrypoint
    assert entrypoint.index("produced no proposal") < entrypoint.index('log "done"')


def test_the_untested_stage_recipe_removes_the_files_it_added():
    """#120: a split's second stage mostly *adds* files, and `git checkout -- .` restores tracked
    files only. The prompt then left untested modules in the sandbox, the harness attached them, and
    the model was told the revert had undone "everything you have not decided to keep"."""
    prompt = (HERE / "prompt.md").read_text()
    assert "checkout -- ." in prompt, "the trap is named, so the model knows the shortcut"
    assert "status --short" in prompt, "the model checks what is actually there"
    assert "clean -fdq" in prompt, "added files have to go too"
