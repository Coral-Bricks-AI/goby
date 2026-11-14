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


def verdict() -> str:
    """The block that decides a review without a findings record has failed, and resolves it."""
    text = entrypoint()
    return text[text.index('if ! grep -q \'"kind":"findings"\''):]


def cancel_handler() -> str:
    """The handler for a SIGTERM the runner sends, which no `goby_fail` call can cover."""
    text = entrypoint()
    return text[text.index('on_cancel() {'):text.index('trap on_cancel TERM INT')]


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


def test_the_run_record_is_written_and_cannot_end_a_review():
    """The record is the same numbers as the timing line, in the one place a review is kept
    forever: the job summary has no API and expires with the log. It is instrumentation like
    everything above it — a record that cannot be written costs a field, never a review."""
    block = after_agent()
    record = block[block.index("runrecord.py"):block.index('goby_log "agent exit=')]
    assert '! python3 /opt/common/runrecord.py "$AGENT_OUT"' in record, record
    assert "--agent-seconds" in record and "--model" in record
    assert '"$OUT/run-record.json"' in record
    # The guard is the `if !`, so the failure path has to clear the half-written file: a truncated
    # record would be parsed later as a record with fields missing.
    assert "rm -f" in record
    # The price comes from the repository's own table, the same convention the cleaners follow.
    assert "$REPO_DIR/.goby/models.json" in block


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


def test_the_progress_note_starts_only_once_nothing_else_can_fail():
    """A "Goby is reviewing" note that nothing marks done is worse than no note. A reuse run
    refreshed a status and a skipped diff posted its verdict, so neither has anything to announce;
    the clone and the proxy can still fail, and the EXIT trap that marks the note done is installed
    after the proxy. So the note starts last, immediately before the work it describes."""
    text = entrypoint()
    start = text.index("\ngoby_progress start\n")
    assert start > text.index("node /opt/goby/reviewRun.js skip")
    assert start > text.index('goby_proxy_start "$UPSTREAM"')
    assert start > text.index("trap 'goby_progress stop")
    assert start < text.index('cp -a "$REPO_DIR/." "$SANDBOX/"')


def test_a_failure_before_the_agent_resolves_the_statuses_it_opened():
    """`prepare` declares "Review in progress" before the clone, so anything that stops this shell
    between them has to say so: a pending status nothing concludes blocks a pull request with
    nothing to read, which review/INVARIANTS.md 1 forbids. The clone failed by `set -e` before this
    ordering change and posted no status at all, so the failure was silent but harmless; now it is
    loud, so it must also be resolved."""
    text = entrypoint()
    helper = text[text.index("goby_fail() {"):text.index("PROVIDER=")]
    assert "reviewRun.js fail" in helper
    assert "exit 1" in helper
    for failure in ('goby_fail "the clone of', 'goby_fail "cannot fetch',
                    'goby_fail "checkout of', 'goby_fail "the diff'):
        assert failure in text, failure


def test_the_agent_has_a_wall_clock_and_it_is_pis_parent():
    """A turn budget is not a clock. 50 turns at a slow provider's latency took 14.5 minutes and the
    runner killed the job at its `timeout-minutes`, which runs no shell of ours: the review never
    reached a verdict and both statuses `prepare` posted stayed pending. `timeout` inside the
    generated script, not around `goby_run_as_agent`, so SIGTERM reaches the process that is
    actually spending the time rather than the `runuser` in front of it."""
    script = launch()
    assert 'exec timeout --signal=TERM --kill-after=30 "$GOBY_AGENT_TIMEOUT_S"' in script
    # Same line as `exec pi`: a `cd` before it is fine, a second process in between is not.
    assert script.index('exec timeout') < script.index('pi --mode json')
    assert 'timeout' not in after_agent(), "the deadline belongs on the agent, not on the reading"


def test_the_deadline_is_an_image_default_under_the_job_timeout():
    """It has to fire first, with the clone and the publish on either side of it. A number the
    workflow sets would not reach a consumer's copy; a number above the job timeout would never
    run."""
    defaults = (HERE / "defaults.env").read_text()
    assert 'GOBY_AGENT_TIMEOUT_S:=600' in defaults
    assert 'export GOBY_MAX_ROUNDS GOBY_MAX_TURNS GOBY_MAX_TOOL_CALLS GOBY_AGENT_TIMEOUT_S' in defaults


def test_a_deadline_failure_names_the_deadline():
    """124 is `timeout` and 137 the `--kill-after` behind it. "exit 124" for a reader to look up is
    not a reason; "spent the budget" is, and it says which knob to turn."""
    block = verdict()
    assert '[[ "$AGENT_STATUS" -eq 124 || "$AGENT_STATUS" -eq 137 ]]' in block
    assert 'GOBY_FAIL_REASON="$REASON"' in block
    assert 'spent its ${GOBY_AGENT_TIMEOUT_S}s wall clock' in block


def test_a_cancel_from_the_runner_resolves_the_statuses_it_opened():
    """The EXIT trap only puts the progress note away. A job the runner stops needs a handler that
    writes a status, or the pull request keeps a pending check and nothing to read — which is what
    the harness did for fourteen minutes of www#2015."""
    handler = cancel_handler()
    assert "reviewRun.js fail" in handler
    assert "GOBY_FAIL_REASON=" in handler
    # Once, and without leaving the note or the proxy behind: the EXIT trap these replace cannot
    # run after `trap -`, so the two cleanups belong here.
    assert "trap - EXIT TERM INT" in handler
    assert "goby_progress stop" in handler and "goby_proxy_stop" in handler
    assert "exit 1" in handler
    text = entrypoint()
    # Armed before `prepare`, because `prepare` is what posts the statuses it resolves.
    assert text.index("trap on_cancel TERM INT") < text.index("node /opt/goby/reviewRun.js prepare")


def test_the_agent_is_waited_on_so_a_cancel_runs_before_the_container_dies():
    """bash defers a trapped signal until the command it is waiting for returns, and the agent is the
    one command that may never return. Run in the foreground, the cancel handler would never run and
    the runner would stop the container with the statuses still pending; `wait` is interruptible, so
    the handler gets the second and a half between the SIGTERM and the teardown."""
    text = entrypoint()
    assert 'bash "$OUT/run-agent.sh" &' in text
    assert 'AGENT_PID=$!' in text
    assert 'wait "$AGENT_PID"' in text
    assert text.index('wait "$AGENT_PID"') < text.index('AGENT_STATUS=$?')
    # The trap counts as installed only if it outlives the handler's own `trap -`, so it is re-armed
    # once and disarmed once, and never inside the block that decides the verdict.
    assert text.count('trap on_cancel TERM INT') == 1


def test_a_cancel_after_a_verdict_is_posted_leaves_that_verdict_alone():
    """Three paths publish and then end: a reused head, a skipped diff, and the review itself. A
    SIGTERM in the window after any of them must not post a failure over a green status — the reuse
    branch posts no pending status to begin with, so the error would appear out of nothing, with a
    reason that is not true, which is the blocked pull request this change exists to remove."""
    text = entrypoint()
    handler = cancel_handler()
    assert 'VERDICT_POSTED' in handler
    # The flag is read before the failure is written, or it protects nothing.
    assert handler.index('VERDICT_POSTED') < handler.index('reviewRun.js fail')
    # Set once per publishing path, immediately before the publish it protects.
    marks = [i for i in range(len(text)) if text.startswith('VERDICT_POSTED=1', i)]
    assert len(marks) == 3, marks
    for mark in marks:
        following = text[mark:mark + 400]
        assert 'reviewRun.js finish' in following or 'reviewRun.js skip' in following, following
    # And the review's own publish is one of them, at the end of the file.
    assert text.rindex('VERDICT_POSTED=1') > text.index('bash "$OUT/run-agent.sh" &')
