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


def test_the_model_share_is_the_agent_wall_clock_minus_the_tools(tmp_path):
    """The whole reason the line exists: 100s of agent, 60.7s of it inside tools."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", 60200, command="uv run pytest tests/x -q"),
                  *tool("read", 500, path="src/a.ts"))
    result = run(str(path), "--agent-seconds", "100")
    assert result.returncode == 0, result.stderr
    assert "agent=100s" in result.stdout
    assert "model=39s" in result.stdout
    assert "tools=60.7s (2 calls: bash 60.2s/1, read 0.5s/1)" in result.stdout


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


def test_a_call_with_no_clock_is_not_folded_into_the_model(tmp_path):
    """A tool that recorded no time puts time into neither side. Subtracting the measured calls
    from the wall clock would have made the model look 90s slower than it was."""
    path = stream(tmp_path, {"type": "turn_start"}, *tool("bash", command="sleep 1"))
    out = run(str(path), "--agent-seconds", "100").stdout
    assert "model=?" in out
    assert "no clock on 1 call(s)" in out
    assert "tools=0.0s (1 calls: bash 0.0s/1)" in out


def test_a_stream_with_no_turn_is_not_all_model_time(tmp_path):
    """pi exits 0 with a session header and no events when the provider refused the key. That is
    a run that never thought, not a run that spent 90s thinking."""
    path = stream(tmp_path, {"type": "session", "version": 3, "id": "x"})
    out = run(str(path), "--agent-seconds", "90").stdout
    assert "model=?" in out
    assert "no turn ever started" in out


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


def test_per_turn_latency_says_whether_the_turns_or_the_model_is_the_problem(tmp_path):
    """The actionable number: 31 turns at 2.5s is too many turns, at 9s it is the model."""
    path = stream(tmp_path, *[{"type": "turn_start"} for _ in range(4)],
                  *tool("read", 1000, path="a"))
    assert ", 7.2s/turn" in run(str(path), "--agent-seconds", "30").stdout


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
    assert summary["model_s"] == 9.0


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
