#!/usr/bin/env python3
"""One line summarising a scan's event stream, and the model-failure check, for its log.

    summarize_run.py /workspace/out/agent/<component>/events.jsonl
    summarize_run.py --status …/events.jsonl     # exit 3 when the model call failed

A clean scan prints nothing to GitHub and nothing to stdout, so the log line is the only
evidence that the run happened and what it concluded. This prints turns, tool calls, the
final stop reason, and the last assistant text — never the raw events, whose final entry
contains the entire conversation including the system prompt.

`--status` exists because pi in `--mode json` exits 0 even when the model call failed: a
429/402 arrives as a message with `stopReason=error` and the run then looks exactly like a
clean scan that found nothing. Only the *last* assistant message decides — pi retries a
failed turn, and an error that was recovered from must not fail a completed scan.

`--timeouts` exists because pi exits 0 after a *tool* error too. A shell command that hits the
harness's wall clock is killed and reported to the model as `Command timed out after N seconds`;
the run then finishes normally, so a scan that was cut short is otherwise indistinguishable from
one that looked and found nothing. The count is read from the event stream's tool results, which
is the run's own record. The string is pi's wording, and the base image pins pi — a bump that
rewords it would make this count zero, which the test beside this file pins against.
"""
import json
import re
import sys
from pathlib import Path

# pi's message for a command the harness killed, from `createShellToolDefinition`. It is the last
# thing appended to the output, which is what makes it a signature rather than a substring: this
# repository's own source contains the phrase, so a `read` of `summarize_run.py` must not look
# like a killed command.
TIMEOUT_MARKER = re.compile(r"Command timed out after \d+ seconds\s*$")


def read_events(path: Path) -> list[dict]:
    try:
        lines = path.read_text(errors="ignore").splitlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def last_assistant(events: list[dict]) -> dict | None:
    last = None
    for ev in events:
        if ev.get("type") != "message_end":
            continue
        msg = ev.get("message") or {}
        if msg.get("role") == "assistant":
            last = msg
    return last


def model_error(last: dict | None) -> str | None:
    """The failure's code, or None. Never the message: it is upstream text."""
    if not last or last.get("stopReason") != "error":
        return None
    raw = str(last.get("errorMessage") or "")
    try:
        body = raw.split(":", 1)[1].strip()
        return str(((json.loads(body).get("error") or {}).get("code")) or "model error")
    except Exception:  # noqa: BLE001 - any shape at all is still a failure
        return (raw.split("(")[0].strip()[:60]) or "model error"


def status(path: Path) -> int:
    code = model_error(last_assistant(read_events(path)))
    if code is None:
        return 0
    print(f"model error: {code}")
    return 3


def timeouts(events: list[dict]) -> int:
    """How many shell commands the harness killed at its wall clock.

    `tool_execution_end` carries the tool result, which is where the text the model saw lives.
    Counting it here rather than writing a file from the extension keeps the verdict on the run's
    own record: the same stream `--status` reads, and the one the log summarises.

    Three conditions, because the phrase also appears in this repository's source (and a tide
    sweeps this repository): the call was `bash`, it failed, and the message is the one pi appends
    when it kills a command. A file whose contents happen to contain the sentence is a `read`, and
    a `bash` command that printed it and then failed is neither an ordinary failure nor a timeout.
    """
    count = 0
    for ev in events:
        if ev.get("type") != "tool_execution_end" or not ev.get("isError"):
            continue
        if ev.get("toolName") != "bash":
            continue
        for item in ((ev.get("result") or {}).get("content") or []):
            if isinstance(item, dict) and TIMEOUT_MARKER.search(str(item.get("text") or "")):
                count += 1
                break
    return count


def summary(path: Path) -> int:
    events = read_events(path)
    if not events:
        print("summary: no event stream")
        return 0
    turns = sum(1 for ev in events if ev.get("type") == "turn_start")
    tools = sum(1 for ev in events if ev.get("type") == "tool_execution_start")
    last = last_assistant(events)
    stop = (last or {}).get("stopReason") or "?"
    parts = [c.get("text", "") for c in ((last or {}).get("content") or [])
             if isinstance(c, dict) and c.get("type") == "text"]
    # Built from the *last* message only: a final turn with no text must not inherit the
    # previous turn's conclusion beside this turn's stop reason.
    text = " ".join("".join(parts).split())
    print(f"summary: turns={turns} tools={tools} stop={stop} "
          f"last={text[:400] if text else '(no text)'}")
    return 0


def main(argv: list[str]) -> int:
    wanted_status = "--status" in argv
    wanted_timeouts = "--timeouts" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if len(paths) != 1:
        print("usage: summarize_run.py [--status|--timeouts] <events.jsonl>", file=sys.stderr)
        return 2
    path = Path(paths[0])
    if wanted_timeouts:
        print(timeouts(read_events(path)))
        return 0
    return status(path) if wanted_status else summary(path)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
