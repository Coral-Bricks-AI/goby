"""The shell contract the sweep's loop depends on.

Asserting shell is weak as a test, and better than the alternative: the failure this pins was
invisible from Python. Five candidates were picked, one was scanned, and the run reported
`failed_scans=0` and exited green because the agent's `pi` read the loop's stdin.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def entrypoint() -> str:
    return (HERE / "entrypoint.sh").read_text()


def test_the_candidate_loop_does_not_read_its_list_from_stdin():
    """`done < file` hands the file to every command in the body. A child that reads stdin takes
    the rest of the list with it, so the sweep scans the first candidate and silently drops the
    others while looking healthy."""
    text = entrypoint()
    assert 'mapfile -t ROWS < "$OUT/picked.tsv"' in text
    assert 'done < "$OUT/picked.tsv"' not in text
    for row in ('for row in ${ROWS[@]+"${ROWS[@]}"}; do', 'IFS=$\'\\t\' read -r check path slug'):
        assert row in text, row


def test_the_agent_gets_no_stdin_of_its_own():
    """Even with the rows read up front, a child inheriting the loop's stdin is a trap for the next
    reader: `/dev/null` says the intent, and makes it impossible for a command to drain anything."""
    text = entrypoint()
    assert '> "$OUT/agent.log" 2>&1 < /dev/null' in text


def test_a_sweep_that_skips_a_picked_candidate_fails_rather_than_reporting_success():
    """The count is the assertion: picked and scanned are two numbers that must agree, and the run
    must not call itself a sweep when they do not."""
    text = entrypoint()
    assert 'if [[ $SCANNED -ne $PICKED_COUNT ]]; then' in text
    assert "that is not a sweep" in text
    assert text.index("$SCANNED -ne $PICKED_COUNT") < text.index('log "done"')


def guard_block(defaults_path: Path) -> str:
    """The entrypoint's numeric guard, verbatim, with only the image's defaults path redirected."""
    text = entrypoint()
    block = text[text.index("must_be_positive() {"):text.index("# A provider is usable")]
    return "log() { printf 'warn %s\\n' \"$*\"; }\n" + block.replace(
        "/opt/tide/defaults.env", str(defaults_path))


def test_a_zero_budget_falls_back_to_the_image_default(tmp_path):
    """`workflow_dispatch` can hand an empty numeric input a value of `0`, and `:=` keeps it because
    0 is not empty: `git clone --depth 0` fails the clone and a threshold of 0 makes every file a
    candidate. The first manual run of a new install can die before it measures anything."""
    import subprocess

    defaults = tmp_path / "defaults.env"
    defaults.write_text(': "${TIDE_MAX_FILE_LINES:=800}"\n'
                        ': "${TIDE_MAX_TEST_FILE_LINES:=1500}"\n'
                        ': "${TIDE_MAX_DIR_FILES:=30}"\n: "${TIDE_MAX_FILE_IMPORTS:=40}"\n'
                        ': "${TIDE_MAX_TODOS:=10}"\n: "${TIDE_MAX_TODO_AGE_DAYS:=365}"\n'
                        ': "${TIDE_MAX_TOOLS:=120}"\n: "${TIDE_HISTORY_DEPTH:=200}"\n')
    script = tmp_path / "guard.sh"
    script.write_text(guard_block(defaults) + '\necho '
                      '"lines=$TIDE_MAX_FILE_LINES depth=$TIDE_HISTORY_DEPTH '
                      'items=$TIDE_MAX_ITEMS per_day=$TIDE_ISSUES_PER_DAY"\n')
    done = subprocess.run(["bash", str(script)], capture_output=True, text=True,
                          env={"TIDE_MAX_FILE_LINES": "0", "TIDE_HISTORY_DEPTH": "0",
                               "TIDE_MAX_ITEMS": "0", "TIDE_ISSUES_PER_DAY": "0",
                               "PATH": "/usr/local/bin:/usr/bin:/bin"})
    assert done.returncode == 0, done.stderr
    # A threshold of 0 is nonsense and is replaced; 0 items and 0 issues-per-day are real choices.
    assert "lines=800" in done.stdout and "depth=200" in done.stdout, (done.stdout, done.stderr)
    assert "items=0" in done.stdout and "per_day=0" in done.stdout, done.stdout
    assert done.stdout.count("is not a positive integer") == 2, done.stdout


def test_a_chosen_threshold_is_kept(tmp_path):
    import subprocess

    defaults = tmp_path / "defaults.env"
    defaults.write_text(': "${TIDE_MAX_FILE_LINES:=800}"\n: "${TIDE_HISTORY_DEPTH:=200}"\n'
                        ': "${TIDE_MAX_TOOLS:=120}"\n')
    done = subprocess.run(["bash", "-c", guard_block(defaults) +
                           '\necho "$TIDE_MAX_FILE_LINES/$TIDE_HISTORY_DEPTH/$TIDE_MAX_TOOLS"\n'],
                          capture_output=True, text=True,
                          env={"TIDE_MAX_FILE_LINES": "5000", "TIDE_HISTORY_DEPTH": "50",
                               "TIDE_MAX_TOOLS": "9", "PATH": "/usr/bin:/bin"})
    assert done.returncode == 0, done.stderr
    # Unset knobs warn and take the default; the three that were chosen keep their values.
    assert done.stdout.strip().splitlines()[-1] == "5000/50/9", (done.stdout, done.stderr)
