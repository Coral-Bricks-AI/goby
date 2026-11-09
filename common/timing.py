#!/usr/bin/env python3
"""Where one agent run spent its wall clock, from the event stream pi already writes.

    timing.py /workspace/out/agent/events.jsonl --agent-seconds 118
    timing.py … --slowest 3

A review used to be timed by two shell counters — seconds around the agent, and a grep of
`findings.jsonl` for the call count — which separates "the agent" from "everything else" and stops
there. That is not enough to answer the first question anyone asking for a faster review has:
whether those two minutes were model round trips or shell commands.

Nothing new has to be measured for it. `tool_execution_end` carries `durationMs`, pi's monotonic
clock around the tool's own `execute`, so the tool share is a sum and the model share is what is
left of the wall clock the caller measured. The stream carries no wall time of its own — a message
timestamp is per message — so `--agent-seconds` supplies the total; without it the line still
reports the tool side rather than inventing the other.

Two things make the total readable rather than merely large:

- every command has a wall clock (`GOBY_BASH_TIMEOUT_S`), so one killed `pytest` and forty fast
  reads total the same; the killed ones are counted, through `summarize_run.py` so the marker is
  read in one place;
- the slowest calls are named with the command that took the time, because "bash 38.9s" invites a
  guess and `uv run pytest tests/x -q 60.0s` ends the argument.

Never a verdict. A stream that is missing, empty or truncated exits 0 with a line saying the split
is unavailable, instead of printing nothing: a review must not fail because an instrument did, and
a missing line must not be mistaken for a fast run.
"""
import argparse
import json
import sys
from pathlib import Path

from summarize_run import read_events, timeouts

# How many tool names the breakdown names before it stops. Three is where a line stops being read
# in a terminal; the rest are in the JSON for whoever needs them.
NAMED_TOOLS = 3
# The argument of a tool call that says what it was pointed at, most specific first.
SUBJECT_ARGS = ("command", "path", "pattern", "query", "url")


def _seconds(event: dict) -> float | None:
    """The tool's own clock, or None. `durationMs` is absent when the tool did not run."""
    ms = event.get("durationMs")
    # `bool` is an `int` in Python, and a `true` here would become 1 ms of bash.
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return None
    return ms / 1000


def _subject(args: dict) -> str:
    """What the call was pointed at, on one line: the command, the path, the pattern."""
    for name in SUBJECT_ARGS:
        value = args.get(name)
        if isinstance(value, str) and value.strip():
            # Collapsed, not truncated per line: a heredoc's useful part is its opening line, and
            # a blank line at the top would otherwise produce an empty label.
            return " ".join(value.split())[:80]
    return ""


def summarise(events: list[dict], agent_s: float | None = None,
              slowest: int = 2) -> dict:
    turns = 0
    tools: dict[str, dict] = {}
    calls: list[tuple[str, float | None, str]] = []
    # What each call was pointed at, keyed by the id both events share. pi splits one call across
    # two records and neither carries both halves: `tool_execution_start` has the arguments,
    # `tool_execution_end` has the clock and no arguments at all (`emitToolExecutionStart` and
    # `emitToolExecutionEnd` in pi's agent loop). Reading `args` off the end event, as the first
    # version of this file did, names every slow call "bash" and answers nothing.
    subjects: dict[str, str] = {}
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    for event in events:
        kind = event.get("type")
        if kind == "turn_start":
            turns += 1
        elif kind == "tool_execution_start":
            call_id = event.get("toolCallId")
            if isinstance(call_id, str):
                subjects[call_id] = _subject(event.get("args") or {})
        elif kind == "tool_execution_end":
            name = event.get("toolName") or "?"
            seconds = _seconds(event)
            row = tools.setdefault(name, {"calls": 0, "s": 0.0, "unmeasured": 0})
            row["calls"] += 1
            if seconds is None:
                row["unmeasured"] += 1
            else:
                row["s"] += seconds
            # Popped, not read: a stream can be long, and an id is used once. An end with no start
            # (a truncated stream) keeps the tool's name and loses only its subject.
            calls.append((name, seconds, subjects.pop(event.get("toolCallId"), "")))
        elif kind == "message_end":
            usage = (event.get("message") or {}).get("usage") or {}
            for key in tokens:
                tokens[key] += usage.get(key) or 0

    tool_calls = sum(row["calls"] for row in tools.values())
    unmeasured = sum(row["unmeasured"] for row in tools.values())
    tools_s = round(sum(row["s"] for row in tools.values()), 1)
    # Only a stream that fully accounts for the run can be subtracted. Reporting a model share
    # computed as `agent_s - (the calls that happened to have a clock)` would credit the model
    # with a tool's time — wrong in the one direction this line exists to get right. A stream with
    # no turn at all is the other end: pi exits 0 when the provider refused the key, emitting a
    # session header and nothing else, and calling that "all model time" would name the wrong bug.
    if agent_s is None or not turns or (tool_calls and unmeasured):
        model_s = None
    else:
        model_s = round(agent_s - tools_s, 1)
    return {
        "agent_s": agent_s,
        "model_s": model_s,
        "tools_s": tools_s,
        "turns": turns,
        "tool_calls": tool_calls,
        "unmeasured_calls": unmeasured,
        "tokens": tokens,
        "timeouts": timeouts(events),
        "tool_time": {name: {"calls": row["calls"], "s": round(row["s"], 1),
                             "unmeasured": row["unmeasured"]}
                      for name, row in sorted(tools.items(), key=lambda kv: -kv[1]["s"])},
        "slowest": [{"tool": name, "s": round(seconds, 1), "subject": subject}
                    for name, seconds, subject in sorted(
                        (call for call in calls if call[1] is not None),
                        key=lambda call: -call[1])[:slowest]],
    }


def _compact(count: int) -> str:
    for limit, suffix in ((1_000_000, "M"), (1_000, "k")):
        if count >= limit:
            return f"{count / limit:.1f}{suffix}".removesuffix(".0")
    return str(count)


def line(summary: dict) -> str:
    """One line for the log. Every number is measured or absent, never a placeholder zero."""
    agent_s = summary["agent_s"]
    tool_calls = summary["tool_calls"]
    parts = ["agent=?" if agent_s is None else f"agent={agent_s:.0f}s"]
    if summary["model_s"] is not None:
        # Per turn, because that is the number a change can act on: 31 turns at 2.5s says the
        # turns are cheap and there are too many, where 31 at 9s says the opposite. `turns` is
        # non-zero here by construction — a stream with no turn has no model share to divide.
        per_turn = summary["model_s"] / summary["turns"]
        parts.append(f"model={summary['model_s']:.0f}s, {per_turn:.1f}s/turn")
    elif not summary["turns"]:
        parts.append("model=?(no turn ever started)")
    elif summary["unmeasured_calls"]:
        parts.append(f"model=?(no clock on {summary['unmeasured_calls']} call(s))")
    if not tool_calls:
        parts.append("tools=0s (no calls)")
    else:
        breakdown = ", ".join(f"{name} {row['s']:.1f}s/{row['calls']}"
                              for name, row in list(summary["tool_time"].items())[:NAMED_TOOLS])
        hidden = len(summary["tool_time"]) - NAMED_TOOLS
        parts.append(f"tools={summary['tools_s']:.1f}s ({tool_calls} calls: {breakdown}"
                     + (f", +{hidden} more" if hidden > 0 else "") + ")")
    parts.append(f"turns={summary['turns']}")
    if summary["timeouts"]:
        parts.append(f"timeouts={summary['timeouts']}")
    spent = summary["tokens"]
    if any(spent.values()):
        parts.append("tokens " + " ".join(f"{name}={_compact(value)}" for name, value in (
            ("in", spent["input"]), ("out", spent["output"]),
            ("cache-read", spent["cacheRead"]), ("cache-write", spent["cacheWrite"]))))
    named = [f'"{call["subject"] or call["tool"]}" {call["s"]:.1f}s' for call in summary["slowest"]]
    if named:
        parts.append("slowest: " + ", ".join(named))
    return "timing " + " ".join(parts)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("events", type=Path)
    parser.add_argument("--agent-seconds", type=float, default=None,
                        help="wall clock around the agent, measured by the caller; the stream has none")
    parser.add_argument("--slowest", type=int, default=2,
                        help="how many of the longest calls to name")
    parser.add_argument("--json", action="store_true",
                        help="the whole summary, for work the one line is too coarse for")
    args = parser.parse_args(argv)

    events = read_events(args.events)
    if not events:
        if args.json:
            print(json.dumps({"agent_s": args.agent_seconds, "tool_calls": None,
                              "note": "no event stream: the model/tool split is unavailable"},
                             indent=2))
        else:
            agent = "" if args.agent_seconds is None else f" (agent={args.agent_seconds:.0f}s)"
            print(f"timing no event stream{agent}: the model/tool split is unavailable")
        return 0
    summary = summarise(events, args.agent_seconds, args.slowest)
    print(json.dumps(summary, indent=2) if args.json else line(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
