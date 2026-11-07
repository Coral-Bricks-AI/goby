"""The one log line that says a run happened, and the model-failure signal.

Shared by every product: a clean run prints nothing to GitHub, so this line is the only
evidence it ran, and pi exits 0 even when the model call failed.
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "summarize_run.py"


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args],
                          capture_output=True, text=True)


def _events(tmp_path, stop_reason, error=None):
    msg = {"role": "assistant", "stopReason": stop_reason,
           "content": [{"type": "text", "text": "done"}]}
    if error:
        msg["errorMessage"] = error
    path = tmp_path / "events.jsonl"
    path.write_text(json.dumps({"type": "message_end", "message": msg}) + "\n")
    return path


def test_the_run_summary_is_one_line_and_never_the_raw_events(tmp_path):
    """A clean scan is silent, so this line is the only evidence it ran — and the last raw
    event carries the whole conversation, system prompt included."""
    events = {
        "type": "message_end",
        "message": {"role": "assistant", "stopReason": "endTurn",
                    "content": [{"type": "text", "text": "Filing nothing.  Clean run."}]},
    }
    path = tmp_path / "events.jsonl"
    path.write_text('{"type":"turn_start"}\n'
                    '{"type":"tool_execution_start","toolName":"read"}\n'
                    + json.dumps(events) + "\n")
    out = run(str(path)).stdout.strip()
    assert out.startswith("summary: turns=1 tools=1 stop=endTurn")
    assert "Filing nothing. Clean run." in out
    assert len(out.splitlines()) == 1


def test_a_final_turn_without_text_does_not_inherit_the_previous_one(tmp_path):
    path = tmp_path / "events.jsonl"
    earlier = {"type": "message_end", "message": {"role": "assistant", "stopReason": "toolUse",
               "content": [{"type": "text", "text": "looking at registry.py"}]}}
    final = {"type": "message_end", "message": {"role": "assistant", "stopReason": "endTurn",
             "content": []}}
    path.write_text(json.dumps(earlier) + "\n" + json.dumps(final) + "\n")
    out = run(str(path)).stdout.strip()
    assert "stop=endTurn" in out
    assert "looking at registry.py" not in out


def test_a_failed_model_call_is_a_failure_not_a_clean_run(tmp_path):
    """pi in `--mode json` exits 0 when the model call fails, so silence is otherwise
    indistinguishable from "no bugs"."""
    path = _events(tmp_path, "error",
                   'AI_APICallError: {"error": {"code": "insufficient_credits"}}')
    out = run("--status", str(path))
    assert out.returncode == 3
    assert "insufficient_credits" in out.stdout


def test_a_completed_turn_passes_the_status_check(tmp_path):
    path = _events(tmp_path, "endTurn")
    out = run("--status", str(path))
    assert out.returncode == 0 and out.stdout == ""


def test_no_event_stream_is_not_a_model_error(tmp_path):
    out = run("--status", str(tmp_path / "missing.jsonl"))
    assert out.returncode == 0


def test_a_command_the_wall_clock_killed_is_counted(tmp_path):
    """pi exits 0 after a tool error, so a scan whose suite hit the command timeout finishes
    normally. Without this count it looks exactly like a scan that looked and found nothing."""
    path = tmp_path / "events.jsonl"
    path.write_text(
        json.dumps({"type": "tool_execution_end", "toolName": "bash", "isError": True,
                    "result": {"content": [{"type": "text",
                                           "text": "output…\n\nCommand timed out after 1200 seconds"}]}}) + "\n"
        # A command that merely failed is not a command that was cut short.
        + json.dumps({"type": "tool_execution_end", "toolName": "bash", "isError": True,
                      "result": {"content": [{"type": "text",
                                             "text": "FAILED src/a.py\n\nCommand exited with code 1"}]}}) + "\n"
        + json.dumps({"type": "tool_execution_end", "toolName": "read",
                      "result": {"content": [{"type": "text", "text": "file contents"}]}}) + "\n"
    )
    out = run("--timeouts", str(path))
    assert out.returncode == 0
    assert out.stdout.strip() == "1", out.stdout


def test_the_marker_in_a_file_is_not_a_command_that_hit_the_wall(tmp_path):
    """The tide sweeps this repository, and this file contains the phrase it counts. A read of
    `summarize_run.py` — the one that found this — must not look like a killed command, or a scan
    that legitimately found nothing fails the sweep."""
    path = tmp_path / "events.jsonl"
    path.write_text(
        json.dumps({"type": "tool_execution_end", "toolName": "read",
                    "result": {"content": [{"type": "text",
                                            "text": 'TIMEOUT_MARKER = "Command timed out after 1200 seconds"'}]}}) + "\n"
        # A command that printed a file containing the phrase and then failed is a failure, not a
        # timeout: pi appends its message at the end, so a signature is what distinguishes them.
        + json.dumps({"type": "tool_execution_end", "toolName": "bash", "isError": True,
                      "result": {"content": [{"type": "text",
                                             "text": "Command timed out after 1200 seconds\n\n"
                                                     "Command exited with code 1"}]}}) + "\n"
        # The same phrase in a *successful* bash result is not a kill either.
        + json.dumps({"type": "tool_execution_end", "toolName": "bash", "isError": False,
                      "result": {"content": [{"type": "text",
                                             "text": "grep hit: Command timed out after 1200 seconds"}]}}) + "\n"
    )
    out = run("--timeouts", str(path))
    assert out.returncode == 0
    assert out.stdout.strip() == "0", out.stdout


def test_no_event_stream_has_no_timeouts(tmp_path):
    out = run("--timeouts", str(tmp_path / "missing.jsonl"))
    assert out.returncode == 0 and out.stdout.strip() == "0"
