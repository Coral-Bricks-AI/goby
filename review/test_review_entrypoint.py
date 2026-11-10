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
    """A review must not fail because an instrument did. Every one of these commands ends in
    `|| true`: the verdict is the findings record, and it is read after all of them."""
    block = after_agent()
    assert "timing.py" in block
    # The trace is one command, wrapped over lines; the guard has to be on it.
    trace = block[block.index("TIMING="):block.index("# One log line per tool call")]
    assert "|| true" in trace, trace
    for argument in ("--agent-seconds", "--findings", "--calls"):
        assert argument in trace, argument


def test_the_trace_reaches_the_log_and_the_summary_line_reaches_the_job_summary():
    """Two readers and two shapes: every line of the trace goes to the log — that is where the
    sequence of calls is read — and only the last line, the summary, goes to the job summary,
    because sixty call lines would bury the pipeline page."""
    block = after_agent()
    assert 'while IFS= read -r trace_line; do goby_log "$trace_line"; done' in block
    assert 'tail -n 1' in block
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


def test_the_reuse_decision_comes_before_the_clone():
    """A head that was already reviewed is a status refresh, and the decision needs GitHub, not a
    working tree. Cloning first made every such run pay ~10s for a diff nothing read — and in a
    repository that reviews once per pull request, most runs are that kind."""
    text = entrypoint()
    prepare = text.index("node /opt/goby/reviewRun.js prepare")
    assert prepare < text.index('git "${AUTH[@]}"')
    # The exit belongs to the branch that reads prepare's answer, not somewhere after the clone.
    reuse_exit = text.index('if grep -q \'"reuse":true\'')
    assert prepare < reuse_exit < text.index("git \"${AUTH[@]}\"")


def test_a_reuse_run_pays_for_nothing_on_the_agent_side():
    """The proxy, the key file, the sandbox copy, the prompt and the agent all belong after the
    reuse exit: none of them can change a verdict that is already published."""
    text = entrypoint()
    reuse_exit = text.index('if grep -q \'"reuse":true\'')
    for late in ('goby_proxy_start "$UPSTREAM"', 'goby_key_to_file "$KEY"',
                 'cp -a "$REPO_DIR/." "$SANDBOX/"', 'bash "$OUT/run-agent.sh"'):
        assert text.index(late) > reuse_exit, late


def test_the_progress_note_starts_only_once_a_review_will_run():
    """A "Goby is reviewing" note that nothing marks done is worse than no note. A reuse run
    refreshed a status and a skipped diff posted its verdict, so neither has anything to announce;
    a clone can fail, and the EXIT trap that marks the note done is set later still (after the
    proxy starts). So the note starts past the diff, never before."""
    text = entrypoint()
    start = text.index("goby_progress start")
    assert start > text.index("node /opt/goby/reviewRun.js skip")
    assert start > text.index('git "${AUTH[@]}"')
    assert start < text.index('goby_proxy_start "$UPSTREAM"')
