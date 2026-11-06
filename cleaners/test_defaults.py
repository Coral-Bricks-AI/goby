"""One source of truth for the scan budgets.

The numbers used to live in the entrypoint fallback, the reusable workflow, and every vendored
copy. A client on `:latest` only inherits a change if the number lives in the image, so assert
that the image owns them and the workflow passes overrides through instead of restating them.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def test_the_numeric_defaults_live_in_the_image():
    defaults = (HERE / "defaults.env").read_text()
    assert ': "${MAX_TOOLS:=200}"' in defaults
    assert ': "${ISSUES_PER_DAY:=25}"' in defaults
    assert ': "${MAX_COMPONENTS:=4}"' in defaults
    entrypoint = (HERE / "entrypoint.sh").read_text()
    assert "source /opt/cleaners/defaults.env" in entrypoint
    for fallback in ('MAX_TOOLS="${MAX_TOOLS:-200}"', 'ISSUES_PER_DAY="${ISSUES_PER_DAY:-25}"',
                     'MAX_COMPONENTS="${MAX_COMPONENTS:-4}"'):
        assert fallback not in entrypoint
    assert "COPY defaults.env /opt/cleaners/defaults.env" in (HERE / "Dockerfile").read_text()
    extension = (HERE / "report_finding.ts").read_text()
    assert "?? 60" not in extension
    assert 'requiredInt("CLEANERS_MAX_TOOLS")' in extension


def test_the_workflow_passes_overrides_and_does_not_restate_the_numbers():
    workflow = (ROOT / ".github/workflows/cleaners-post-merge.yml").read_text()
    assert "MAX_TOOLS: ${{ inputs.max-tools }}" in workflow
    assert "ISSUES_PER_DAY: ${{ inputs.issues-per-day }}" in workflow
    assert "MAX_COMPONENTS: ${{ inputs.max-components }}" in workflow
    for fallback in ("inputs.max-tools || 60", "inputs.issues-per-day || 25",
                     "inputs.max-components || 4", "default: 60", "default: 25", "default: 4"):
        assert fallback not in workflow


def test_every_shipped_module_compiles_without_escape_warnings():
    """A docstring that quotes `\\W` is a regular string: Python 3.12 warns and later versions
    will not read it as intended. The image's Python must compile every file it ships."""
    import subprocess
    import sys

    for path in sorted(HERE.glob("*.py")):
        done = subprocess.run([sys.executable, "-W", "error::SyntaxWarning", "-B",
                               "-m", "py_compile", str(path)],
                              capture_output=True, text=True)
        assert done.returncode == 0, (path.name, done.stderr)
