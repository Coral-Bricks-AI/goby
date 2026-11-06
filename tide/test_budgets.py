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
                        ("TIDE_MAX_TOOLS", 120), ("TIDE_ISSUES_PER_DAY", 5)):
        assert f': "${{{name}:={value}}}"' in defaults, name


def test_the_entrypoint_sources_the_defaults_and_never_restates_a_number():
    entrypoint = (HERE / "entrypoint.sh").read_text()
    assert "source /opt/tide/defaults.env" in entrypoint
    for name, value in (("TIDE_MAX_ITEMS", 3), ("TIDE_MAX_TOOLS", 120),
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


def test_the_workflow_passes_overrides_and_does_not_restate_the_numbers():
    workflow = WORKFLOW.read_text()
    for name, value in (("TIDE_MAX_ITEMS", 3), ("TIDE_MAX_TOOLS", 120),
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
