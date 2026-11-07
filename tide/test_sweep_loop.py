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
