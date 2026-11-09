"""The agent's two streams, asserted from the shell.

`review/entrypoint.sh` is not unit-tested anywhere, and the two decisions here are the ones whose
failure is silent: an agent put back on `--print` still reviews correctly and only stops reporting
where its time went, and an instrument that is not `|| true` turns a diagnostic into a new way for
a review to fail. Neither is visible from a test of `common/timing.py`, which is the tool and not
the wiring.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def entrypoint() -> str:
    return (HERE / "entrypoint.sh").read_text()


def launch() -> str:
    """The generated agent script: the one place the agent's own command line is decided."""
    text = entrypoint()
    start = text.index('cat > "$OUT/run-agent.sh" <<RUN')
    return text[start:text.index("\nRUN", start)]


def after_agent() -> str:
    """What runs once the agent has exited, up to the findings-record verdict."""
    text = entrypoint()
    start = text.index('AGENT_STATUS=$?')
    return text[start:text.index('if ! grep -q \'"kind":"findings"\'', start)]


def test_the_agent_writes_an_event_stream_and_not_just_its_last_message():
    """`--mode json` is what makes the run's cost readable: `tool_execution_end` carries
    `durationMs`, and nothing else in the review records a tool's own clock. `--print` reviews
    correctly and reports only that the split is unavailable, so it cannot fail loudly on its own."""
    script = launch()
    assert "--mode json" in script
    assert "--print" not in script
    assert '> "$AGENT_OUT/events.jsonl"' in script


def test_the_agent_streams_go_where_the_agent_can_write_them():
    """The agent runs as uid 10001 and `$OUT` is root-owned on purpose. Sending the stream there
    would leave the run with no record at all, and the log would say the split was unavailable
    without saying why."""
    script = launch()
    assert '"$OUT/events.jsonl"' not in script
    assert '"$OUT/stderr.log"' not in script


def test_the_timing_line_is_printed_and_cannot_end_a_review():
    """A review must not fail because an instrument did. Every call in this block is `|| true`:
    the verdict is the findings record, and it is read after all of them."""
    block = after_agent()
    for line in block.splitlines():
        if "/opt/common/" in line and "python3" in line:
            assert "|| true" in line, line
    assert "timing.py" in block
    assert "--agent-seconds" in block


def test_the_timing_line_reaches_the_job_summary_and_the_log():
    """Two readers: the log for whoever is looking at the run, the job summary for whoever is
    looking at the pipeline. A line that lands in only one of them is a line half the audience
    never sees."""
    block = after_agent()
    assert "goby_log \"$TIMING\"" in block
    assert "GITHUB_STEP_SUMMARY" in block


def test_no_event_stream_names_the_cause_instead_of_only_the_symptom():
    """A rejected key writes a session header and nothing else, so the stream is neither absent
    nor empty; the reason is in pi's own stderr. Without it the last line before the failure is
    "the reviewer never reported", with nothing above it explaining why."""
    text = entrypoint()
    failure = text[text.index('goby_log "error: the reviewer never reported'):]
    assert "no event stream" in text
    assert 'tail -20 "$AGENT_OUT/stderr.log"' in failure


def test_the_verdict_is_still_the_findings_record():
    """The stream, the summary and the timing split are evidence, not decisions. A review that
    produced no findings record still fails, whatever the instrumentation said about it."""
    text = entrypoint()
    assert 'if ! grep -q \'"kind":"findings"\' "$AGENT_OUT/findings.jsonl"' in text
