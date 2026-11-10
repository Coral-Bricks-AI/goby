"""The split an argument about review latency needs, from the stream pi already writes.

The point of this file is the *subtraction*: the tool side is measured (`durationMs`), the model
side is the wall clock the caller measured minus that, and a number is reported only when both
sides are real. A split that quietly credits the model with a shell command's time would send
somebody optimising the wrong half.
"""
import itertools
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "timing.py"


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args],
                          capture_output=True, text=True)


def stream(tmp_path, *events) -> Path:
    path = tmp_path / "events.jsonl"
    path.write_text("".join(json.dumps(event) + "\n" for event in events))
    return path


IDS = itertools.count()


def tool(name, ms=None, **args):
    """One call as pi writes it: the arguments on `start`, the clock on `end`, and an id joining
    the two. `tool_execution_end` carries no `args` at all — a fixture that puts them there tests
    a stream pi never emits, which is how the first version of this file shipped with every slow
    call named "bash". """
    call_id = f"call_{next(IDS)}"
    end = {"type": "tool_execution_end", "toolCallId": call_id, "toolName": name, "isError": False}
    if ms is not None:
        end["durationMs"] = ms
    return [{"type": "tool_execution_start", "toolCallId": call_id, "toolName": name, "args": args},
            end]


def test_the_model_share_is_measured_per_request_and_never_subtracted(tmp_path):
    """The tool sum is *not* taken out of the agent's clock. pi runs a turn's tool calls
    concurrently, so two overlapping 40s commands add 80s to that sum while occupying 40s of wall
    clock — and subtracting it invented 35s of model time that never happened (goby review, #148)."""
    overlap = [*tool("bash", 40000, command="pytest -q"), *tool("bash", 40000, command="ruff check")]
    path = stream(tmp_path, {"type": "turn_start"}, *overlap, response(3000))
    out = run(str(path), "--agent-seconds", "45").stdout
    assert "agent=45s" in out
    assert "model=3s" in out                      # measured, not 45 - 80
    assert "other=+42.0s" in out                    # the rest of the wall clock, unnamed
    assert "tools=80.0s" in out                   # the sum itself, which overstates the wall time
    assert "unaccounted" not in out


def test_the_agent_and_the_model_do_not_have_to_agree(tmp_path):
    """Two independent measurements: pi times the request, the shell times the agent. A remainder
    too small to matter is not printed, and the model side is marked as a lower bound when pi did
    not time every response."""
    path = stream(tmp_path, {"type": "turn_start"}, response(2000))
    assert "other=" not in run(str(path), "--agent-seconds", "2.1").stdout
    path = stream(tmp_path, {"type": "turn_start"}, response(1000), response(None))
    out = run(str(path), "--agent-seconds", "5").stdout
    assert "model>=1s" in out
    assert "other=" not in out


def test_the_slowest_calls_are_named_with_what_they_were_pointed_at(tmp_path):
    """`bash 38.9s` invites a guess; the command ends the argument about what to cut. The command
    is on the `start` event, not the `end` one, so this pins the pairing by call id."""
    path = stream(tmp_path, {"type": "turn_start"},
                  *tool("bash", 60000, command="uv run pytest tests/x -q\n  && echo done"),
                  *tool("bash", 3000, command="rg -n TODO src"))
    out = run(str(path), "--agent-seconds", "70").stdout
    assert 'slowest: "uv run pytest tests/x -q && echo done" 60.0s, "rg -n TODO src" 3.0s' in out


def test_a_call_with_no_start_keeps_its_name_and_loses_only_the_subject(tmp_path):
    """A stream can be cut short at any point. An end with no matching start still has its clock
    and its tool name, and must not take the line down or invent a subject."""
    path = stream(tmp_path, {"type": "turn_start"},
                  {"type": "tool_execution_end", "toolCallId": "orphan", "toolName": "bash",
                   "durationMs": 2000, "isError": False})
    out = run(str(path), "--agent-seconds", "10").stdout
    assert 'slowest: "bash" 2.0s' in out


def test_a_tool_that_recorded_no_time_does_not_touch_the_model_share(tmp_path):
    """The model side is pi's own per-request timing now, so a tool without a clock can only make
    the *tool* number smaller than it was — it cannot move the model one."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", command="sleep 1"), response(4000))
    out = run(str(path), "--agent-seconds", "100").stdout
    assert "model=4s" in out
    assert "tools=0.0s (1 calls: bash 0.0s/1)" in out


def test_a_stream_with_no_turn_is_not_all_model_time(tmp_path):
    """pi exits 0 with a session header and no events when the provider refused the key. That is
    a run that never thought, not a run that spent 90s thinking."""
    path = stream(tmp_path, {"type": "session", "version": 3, "id": "x"})
    out = run(str(path), "--agent-seconds", "90").stdout
    # No turn, so no request was made and no model share is claimed — only the reason.
    assert "model=?(no turn ever started)" in out
    assert "turns=0" in out
    assert "requests=" not in out


def test_the_timeouts_are_counted_at_the_bash_wall_clock(tmp_path):
    """One killed `pytest` and forty fast reads look identical in a total; that is the reading
    this count prevents."""
    killed = {"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash",
              "durationMs": 120000, "isError": True,
              "result": {"content": [{"type": "text",
                                      "text": "Command timed out after 120 seconds"}]}}
    path = stream(tmp_path, {"type": "turn_start"},
                  {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash",
                   "args": {"command": "uv run pytest -q"}}, killed)
    assert "timeouts=1" in run(str(path), "--agent-seconds", "130").stdout


def test_tokens_are_summed_across_every_message(tmp_path):
    """Per-turn context is what makes the last turn slow, so the four classes stay separate —
    input and cache-read against output is the difference between reading and writing."""
    path = stream(tmp_path, {"type": "turn_start"},
                  {"type": "message_end", "message": {"role": "assistant", "usage": {
                      "input": 1000, "output": 200, "cacheRead": 50000, "cacheWrite": 10}}},
                  {"type": "message_end", "message": {"role": "assistant", "usage": {
                      "input": 500, "output": 300, "cacheRead": 60000}}})
    out = run(str(path), "--agent-seconds", "30").stdout
    assert "tokens in=1.5k out=500 cache-read=110.0k cache-write=10" in out


def response(ms, out=200, **extra):
    """One assistant response as pi finalises it: `durationMs` is pi's own monotonic timing of the
    request, so a distribution built from it is measured, not subtracted."""
    message = {"role": "assistant", "timestamp": 1, "durationMs": ms, "stopReason": "toolUse",
               "usage": {"input": 0, "output": out, "cacheRead": 42000, "cacheWrite": 10},
               "content": [{"type": "text", "text": "x" * 40}]}
    message.update(extra)
    return {"type": "message_end", "message": message}


def test_the_model_time_is_a_distribution_not_only_an_average(tmp_path):
    """What a change can act on is the shape. 43 requests at 1.3s and one at 9s are different
    problems, and their mean hides both."""
    path = stream(tmp_path, {"type": "turn_start"}, response(900, 200),
                  {"type": "turn_start"}, response(1200, 250),
                  {"type": "turn_start"}, response(1400, 300),
                  {"type": "turn_start"}, response(2500, 500),
                  {"type": "turn_start"}, response(6100, 900))
    out = run(str(path), "--agent-seconds", "12.3").stdout
    # Nearest rank: p50 is the 3rd of 5 measurements, p95 is the 5th — never an interpolation.
    assert "requests=5 p50=1.4s p95=6.1s max=6.1s" in out
    # The old single average is gone: every `/turn` left in the line is `calls/turn`.
    assert out.count("s/turn") == out.count("calls/turn")


def test_the_slowest_turn_says_how_much_it_wrote(tmp_path):
    """A slow request that wrote a lot is throughput; one that wrote little is latency. Without the
    token count beside it the two read the same."""
    path = stream(tmp_path, {"type": "turn_start"}, response(1000, 100),
                  {"type": "turn_start"}, response(6000, 950))
    out = run(str(path), "--agent-seconds", "8").stdout
    assert "max=6.0s (turn 2: 950 out)" in out


def test_a_request_pi_did_not_time_is_counted_not_assumed(tmp_path):
    """pi leaves `durationMs` off a response it did not see start, such as a deferred result. The
    distribution is over the timed ones and says so, rather than treating the gap as zero seconds."""
    path = stream(tmp_path, {"type": "turn_start"}, response(1000),
                  {"type": "turn_start"}, response(3000),
                  {"type": "turn_start"}, response(None))
    out = run(str(path), "--agent-seconds", "6").stdout
    assert "requests=2/3 p50=1.0s" in out


def test_a_stream_with_no_response_does_not_invent_a_distribution(tmp_path):
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 10, command="ls"))
    out = run(str(path), "--agent-seconds", "1").stdout
    assert "requests=" not in out


def test_the_line_never_echoes_the_prompt_or_the_diff(tmp_path):
    """The stream carries the whole brief, including the diff. This line goes to a public job
    log, so it may carry counts and durations and nothing a message contained."""
    secret = "SECRET-DIFF-CONTENT-should-never-be-printed"
    path = stream(tmp_path, {"type": "turn_start"}, {
        "type": "message_end", "message": {"role": "user", "usage": {},
                                           "content": [{"type": "text", "text": secret}]}},
        *tool("bash", 10, command="cat"))
    result = run(str(path), "--agent-seconds", "5")
    assert secret not in result.stdout + result.stderr
    assert secret not in run(str(path), "--agent-seconds", "5", "--json").stdout


def test_no_stream_still_exits_zero_and_says_the_split_is_unavailable(tmp_path):
    """An absent instrument must not fail a review, and must not look like a fast one either."""
    result = run(str(tmp_path / "absent.jsonl"), "--agent-seconds", "12")
    assert result.returncode == 0
    assert "no event stream (agent=12s)" in result.stdout
    assert "unavailable" in result.stdout


def test_garbage_in_the_stream_is_skipped_rather_than_fatal(tmp_path):
    """A jsonl file can end mid-line if the container dies; the readable part is still evidence."""
    path = tmp_path / "events.jsonl"
    path.write_text(json.dumps({"type": "turn_start"}) + "\n{not json\n"
                    + "".join(json.dumps(e) + "\n" for e in tool("bash", 2000, command="ls")))
    result = run(str(path), "--agent-seconds", "4")
    assert result.returncode == 0
    assert "tools=2.0s (1 calls: bash 2.0s/1)" in result.stdout


def test_the_json_carries_every_tool_not_just_the_named_ones(tmp_path):
    """The line stops at three tool names so it stays readable; a longer list has to be reachable
    without a second measurement."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("read", 100, path="a"),
                  *tool("grep", 200, pattern="b"), *tool("find", 300, path="c"),
                  *tool("ls", 400, path="d"))
    summary = json.loads(run(str(path), "--agent-seconds", "10", "--json").stdout)
    assert [name for name in summary["tool_time"]] == ["ls", "find", "grep", "read"]
    assert summary["tool_time"]["ls"] == {"calls": 1, "s": 0.4, "unmeasured": 0}
    # No assistant message, so nothing pi timed: the model share is unknown, not zero.
    assert summary["model_s"] is None
    assert summary["requests"]["count"] == 0
    assert summary["other_s"] is None


def test_calls_per_turn_says_whether_the_probes_shared_a_round_trip(tmp_path):
    """Every turn is a round trip to the model, so two probes in one turn is one turn saved. The
    ratio alone would hide it: 3 calls over 2 turns reads the same as 3 turns of one call."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 10, command="a"),
                  *tool("bash", 10, command="b"), {"type": "turn_start"},
                  *tool("bash", 10, command="c"))
    out = run(str(path), "--agent-seconds", "10").stdout
    assert "turns=2 calls/turn=1.5 (1/2 ran 2+)" in out


def test_a_run_that_never_batches_does_not_claim_it_did(tmp_path):
    """The marker is absent rather than "0/3 ran 2+": a number that is only ever printed when it
    is interesting stays readable in a log of sixty lines."""
    one_probe_per_turn = []
    for index in range(3):
        one_probe_per_turn.append({"type": "turn_start"})
        one_probe_per_turn.extend(tool("bash", 10, command=f"cmd{index}"))
    path = stream(tmp_path, *one_probe_per_turn)
    out = run(str(path), "--agent-seconds", "10").stdout
    assert "turns=3 calls/turn=1.0" in out
    assert "ran 2+" not in out


def test_the_call_sequence_names_each_call_with_the_turn_it_belonged_to(tmp_path):
    """The answer to "is it batching?" is the sequence, not the average: three calls under one
    `turn=` were one round trip, three `turn=` lines of one call were three."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 30, command="grep -rn x ml/"),
                  *tool("read", 5, path="ml/a.py"), {"type": "turn_start"},
                  *tool("bash", 60000, command="pytest -q"))
    out = run(str(path), "--agent-seconds", "30", "--calls").stdout.splitlines()
    assert out[0] == "call  1 bash 0.03s grep -rn x ml/"
    assert out[1] == "call  1 read 0.01s ml/a.py"
    assert out[2] == "call  2 bash 60.00s pytest -q"
    # The summary still comes last, so one invocation answers both questions.
    assert out[-1].startswith("timing agent=30s")


def test_a_failed_call_is_marked_in_the_sequence(tmp_path):
    """A command that failed is the difference between "it looked" and "it concluded", and the one
    that hit the wall clock is exactly the interesting line."""
    broken = tool("bash", 120000, command="pytest -q")
    broken[1]["isError"] = True
    path = stream(tmp_path, {"type": "turn_start"}, *broken)
    out = run(str(path), "--agent-seconds", "130", "--calls").stdout
    assert "call  1 bash 120.00s ! pytest -q" in out


def findings(tmp_path, *records) -> Path:
    path = tmp_path / "findings.jsonl"
    path.write_text("".join(json.dumps(record) + "\n" for record in records))
    return path


def test_the_budget_notices_are_read_from_the_record_the_extension_leaves(tmp_path):
    """A notice is a conversation entry and the conversation is not kept, so the record is the only
    evidence a nudge fired at all. `notices=0` is a fact too: it converged before being nudged."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 10, command="a"))
    record = findings(tmp_path,
                      {"kind": "budget", "turns": 40, "remaining": 10, "threshold": 10},
                      {"kind": "budget", "turns": 45, "remaining": 5, "threshold": 5},
                      {"kind": "findings", "findings": []})
    out = run(str(path), "--agent-seconds", "20", "--findings", str(record)).stdout
    assert "notices=2" in out
    assert "blocked=" not in out


def test_a_run_cut_off_at_the_cap_says_so(tmp_path):
    """The wrap-up writes a `blocked` record, which is also what puts "Partial scan" in the review
    body. Seeing the reason here means the cap engaged without opening the pull request."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 10, command="a"))
    record = findings(tmp_path, {"kind": "blocked", "tool_calls": 60, "turns": 50, "reason": "turns"},
                      {"kind": "findings", "findings": []})
    out = run(str(path), "--agent-seconds", "20", "--findings", str(record)).stdout
    assert "blocked=turns" in out


def test_without_a_findings_file_the_notice_count_is_absent_not_zero(tmp_path):
    """No record means the question is unanswerable, not answered "no": a review that died before
    writing anything must not look like one that was never nudged."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 10, command="a"))
    result = run(str(path), "--agent-seconds", "20", "--findings", str(tmp_path / "absent.jsonl"))
    assert "notices=" not in result.stdout
    summary = json.loads(run(str(path), "--agent-seconds", "20", "--json",
                             "--findings", str(tmp_path / "absent.jsonl")).stdout)
    assert summary["notices"] is None


def test_the_json_carries_the_sequence_and_the_batching(tmp_path):
    """What a later question needs without a second pass over a 50 MB stream."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 10, command="a"),
                  *tool("bash", 20, command="b"))
    summary = json.loads(run(str(path), "--agent-seconds", "10", "--json").stdout)
    assert summary["calls_per_turn"] == {"0": 0, "1": 0, "2+": 1}
    assert summary["batched_turns"] == 1
    assert [(call["turn"], call["tool"], call["s"]) for call in summary["calls"]] == [(1, "bash", 0.01), (1, "bash", 0.02)]


def assistant(chars, out_tokens=None, reasoning=None, **blocks):
    """One final assistant message: the record, which is what the split is read from."""
    content = []
    for kind, text in blocks.items():
        if kind == "toolCall":
            content.append({"type": "toolCall", "id": "c1", "name": "bash", "arguments": text})
        else:
            content.append({"type": kind, "text": text} if kind == "text"
                           else {"type": "thinking", "thinking": text})
    usage = {"input": 0, "output": out_tokens if out_tokens is not None else chars // 4,
             "cacheRead": 42000, "cacheWrite": 100}
    if reasoning is not None:
        usage["reasoning"] = reasoning
    return {"type": "message_end",
            "message": {"role": "assistant", "content": content, "usage": usage}}


def test_the_content_is_reported_in_characters_and_nothing_is_invented(tmp_path):
    """There is no tokenizer in the review image, so characters are published as characters. The
    previous version divided them by four, and a real run showed the remainder it called "not in
    content" was nothing but that divisor: 94,800 characters of a 27,500-token response."""
    path = stream(tmp_path, {"type": "turn_start"},
                  assistant(0, 2500, thinking="t" * 8000, text="x" * 1000,
                            toolCall={"command": "a" * 987}))
    out = run(str(path), "--agent-seconds", "4").stdout
    assert "content thinking=8.0k ch" in out
    assert "text=1.0k ch" in out
    assert "~2.5k tok" not in out
    assert "not in content" not in out


def test_the_token_split_is_the_providers_counts_not_a_divisor(tmp_path):
    """`usage.reasoning` is the provider's own count and a documented subset of `output`, so
    reasoning and answer are both measurements: 27.5k out = 20k reasoning + 7.5k answer."""
    path = stream(tmp_path, {"type": "turn_start"}, assistant(0, 27500, reasoning=20000,
                                                              thinking="t" * 69000))
    out = run(str(path), "--agent-seconds", "4").stdout
    assert "reasoning=20.0k answer=7.5k" in out
    # 69,000 characters of thinking per 20,000 reasoning tokens: text, not a doubled transcript.
    assert "(3.5 ch/thinking tok)" in out
    summary = json.loads(run(str(path), "--agent-seconds", "4", "--json").stdout)
    assert summary["reasoning_tokens"] == 20000
    assert summary["answer_tokens"] == 7500
    assert summary["chars_per_reasoning_token"] == 3.5


def test_a_zero_reasoning_count_is_never_published_as_a_measurement(tmp_path):
    """pi writes `output_tokens_details?.reasoning_tokens || 0`, so a missing breakdown and a real
    zero are the same number on the wire — with or without thinking text to see. Only a positive
    count is evidence, so a zero is reported as unreported either way: "no reasoning" is a claim
    the stream cannot support, and `answer = output` would inherit it."""
    for thinking in ("t" * 69000, ""):
        path = stream(tmp_path, {"type": "turn_start"},
                      assistant(0, 27500, reasoning=0, thinking=thinking, text="x" * 40))
        out = run(str(path), "--agent-seconds", "4").stdout
        assert "reasoning=" not in out
        assert "answer=" not in out
        summary = json.loads(run(str(path), "--agent-seconds", "4", "--json").stdout)
        assert summary["reasoning_tokens"] is None
        assert summary["answer_tokens"] is None


def test_a_doubled_transcript_announces_itself(tmp_path):
    """The gateway repeats the raw reasoning on its summary channel when `reasoning.summary` is
    set, and pi appends both into one thinking block. That is ~7 characters per reasoning token
    instead of ~3.5, and it matters because pi replays that text upstream."""
    path = stream(tmp_path, {"type": "turn_start"},
                  assistant(0, 27500, reasoning=10000, thinking="t" * 69000))
    assert "(6.9 ch/thinking tok, duplicated?)" in run(str(path), "--agent-seconds", "4").stdout


def test_a_run_with_no_content_does_not_claim_a_split(tmp_path):
    """A stream whose messages carry usage and no blocks is not a run whose output was zero."""
    path = stream(tmp_path, {"type": "turn_start"},
                  {"type": "message_end", "message": {
                      "role": "assistant", "content": [],
                      "usage": {"input": 0, "output": 500, "cacheRead": 10, "cacheWrite": 0}}})
    out = run(str(path), "--agent-seconds", "2").stdout
    assert "out=500" in out
    assert "content " not in out
    assert "reasoning=" not in out


def test_the_brief_the_agent_reads_is_not_counted_as_content(tmp_path):
    """A user message carries the prompt and the whole diff; counting it would drown the one number
    this split exists to report, in the direction that makes the reviewer look chatty."""
    path = stream(tmp_path, {"type": "turn_start"},
                  {"type": "message_end", "message": {
                      "role": "user", "content": [{"type": "text", "text": "z" * 50000}]}},
                  assistant(0, 100, text="y" * 400))
    out = run(str(path), "--agent-seconds", "2").stdout
    assert "content text=400 ch" in out
