#!/usr/bin/env python3
"""Where one agent run spent its wall clock, from the event stream pi already writes.

    timing.py /workspace/out/agent/events.jsonl --agent-seconds 118
    timing.py … --calls --findings …/findings.jsonl   # one line per tool call, then the summary
    timing.py … --json                              # the whole summary, for anything deeper

A review used to be timed by two shell counters — seconds around the agent, and a grep of
`findings.jsonl` for the call count — which separates "the agent" from "everything else" and stops
there. That is not enough to answer the first question anyone asking for a faster review has:
whether those two minutes were model round trips or shell commands.

Nothing new has to be measured for it. Two clocks are already in the stream: `tool_execution_end`
carries `durationMs`, pi's monotonic time around the tool's own `execute`, and every assistant
message carries its own `durationMs` — the request's start to its end, on the same monotonic clock
(`pi-ai/utils/event-stream.js`). So the tool share is a sum, the model share is what is left of the
wall clock the caller measured, and the per-request distribution is pi's own measurement rather than
a difference of wall clocks that a clock adjustment could bend.

Two things make the total readable rather than merely large:

- every command has a wall clock (`GOBY_BASH_TIMEOUT_S`), so one killed `pytest` and forty fast
  reads total the same; the killed ones are counted, through `summarize_run.py` so the marker is
  read in one place;
- the slowest calls are named with the command that took the time, because "bash 38.9s" invites a
  guess and `uv run pytest tests/x -q 60.0s` ends the argument.

And two things say what the run *did* with that time, which is the question behind "can we make a
review faster": `calls/turn` counts how many probes shared a round trip, the budget notices the
reviewer was given are read from the records `report_findings.ts` leaves beside the findings — the
conversation those nudges went into is not kept, so without them whether a nudge fired is unknowable
— and the output is split by what the model was writing: thinking, tool calls, final text.

The last one comes from the **final** assistant messages, not from the `message_update` deltas. pi's
docs are explicit that deltas are for live rendering and that the completed content in
`*_end` replaces them; a provider that re-sends a cumulative snapshot would be counted twice, and a
block trimmed on the way in would be counted never. `AssistantMessage.content` is
`(text | thinking | toolCall)[]`, so the split is read from the record.

It is measured in characters, not tokens, because that is what the stream carries. Four characters
per token is the usual approximation, so the figure is published as approximate and, where it falls
short of the billed `out=` count, the line says how much of the output is not in the content at all —
reasoning tokens a provider does not stream back are exactly the case that has to stay visible
instead of being rounded into "text".

Never a verdict. A stream that is missing, empty or truncated exits 0 with a line saying the split
is unavailable, instead of printing nothing: a review must not fail because an instrument did, and
a missing line must not be mistaken for a fast run.
"""
import argparse
import json
import math
import sys
from pathlib import Path

from summarize_run import read_events, timeouts

# How many tool names the breakdown names before it stops. Three is where a line stops being read
# in a terminal; the rest are in the JSON for whoever needs them.
NAMED_TOOLS = 3
# The argument of a tool call that says what it was pointed at, most specific first.
SUBJECT_ARGS = ("command", "path", "pattern", "query", "url")
# pi's `AssistantMessage.content` blocks, and the field in each that carries the text.
BLOCK_FIELDS = (("thinking", "thinking"), ("text", "text"), ("toolCall", "arguments"))
# Characters per token, for the one comparison the stream cannot make in tokens. An approximation,
# and published as one: the split it feeds is a share, which holds because both sides use it.
CHARS_PER_TOKEN = 4


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
            # a blank line at the top would otherwise produce an empty label. Wide enough for the
            # usual `cd <sandbox> && grep -n <pattern> <path>`, because the path is at the end.
            return " ".join(value.split())[:110]
    return ""


def _findings(path: Path | None) -> dict:
    """What the reviewer recorded about its own budget.

    A budget notice is a conversation entry and the conversation is not kept, so the record beside
    the findings (`report_findings.ts`) is the only evidence that a nudge fired. `notices` is None
    when there is no record at all — a review that died before writing one — never 0.
    """
    if path is None or not path.is_file():
        return {"notices": None, "notice_turns": [], "blocked": None}
    notice_turns: list[int | None] = []
    blocked = None
    for record in read_events(path):
        kind = record.get("kind")
        if kind == "budget":
            notice_turns.append(record.get("turns"))
        elif kind == "blocked" and blocked is None:
            blocked = str(record.get("reason") or "?")
    return {"notices": len(notice_turns), "notice_turns": notice_turns, "blocked": blocked}


def _block_chars(message: dict) -> dict[str, int]:
    """Characters in one assistant message, by kind of content block.

    `toolCall.arguments` is an object on the final message (it is the serialized string only in
    `toolcall_delta`), so it is measured serialized: what the model spent writing the call is the
    arguments it wrote, not the Python repr.
    """
    counts = {name: 0 for name, _field in BLOCK_FIELDS}
    counts["other"] = 0
    for block in message.get("content") or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type") if isinstance(block.get("type"), str) else "other"
        field = dict(BLOCK_FIELDS).get(kind)
        value = block.get(field) if field else None
        if isinstance(value, str):
            counts[kind if kind in counts else "other"] += len(value)
        elif isinstance(value, (dict, list)):
            counts[kind if kind in counts else "other"] += len(
                json.dumps(value, separators=(",", ":")))
    return counts


def _percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile, so the number is always one of the measurements.

    An interpolated percentile of 43 requests invents a latency nothing observed, and the point of
    reporting p95 here is to name the slow tail, not to smooth it.
    """
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[rank - 1]


def _request_seconds(message: dict) -> float | None:
    """pi's own monotonic timing of one request, or None when pi did not time it.

    `AssistantMessage.durationMs` is set by pi's `AssistantMessageEventStream`: milliseconds from the
    request starting to the response ending (`pi-ai/dist/utils/event-stream.js`). So this is not a
    subtraction — no tool time to take out, no difference of two wall clocks. It is absent when pi
    forwards a response that started elsewhere (a deferred result), which is why the timed count is
    reported next to the request count rather than assumed.
    """
    ms = message.get("durationMs")
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return None
    return ms / 1000


def summarise(events: list[dict], agent_s: float | None = None,
              slowest: int = 2, findings: Path | None = None) -> dict:
    turns = 0
    tools: dict[str, dict] = {}
    calls: list[tuple[int, str, float | None, str, bool]] = []
    # How many tool calls each turn ran. One call per turn is the loop this line exists to make
    # visible: every turn is a round trip to the model, so batching three probes into one turn is
    # two round trips saved at no cost in work done.
    per_turn: list[int] = []
    # What each call was pointed at, keyed by the id both events share. pi splits one call across
    # two records and neither carries both halves: `tool_execution_start` has the arguments,
    # `tool_execution_end` has the clock and no arguments at all (`emitToolExecutionStart` and
    # `emitToolExecutionEnd` in pi's agent loop). Reading `args` off the end event, as the first
    # version of this file did, names every slow call "bash" and answers nothing.
    subjects: dict[str, str] = {}
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    # One entry per assistant response, with pi's timing of that request where it has one.
    requests: list[dict] = []
    output_chars = {name: 0 for name, _field in BLOCK_FIELDS}
    output_chars["other"] = 0
    for event in events:
        kind = event.get("type")
        if kind == "turn_start":
            turns += 1
            per_turn.append(0)
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
            calls.append((len(per_turn), name, seconds, subjects.pop(event.get("toolCallId"), ""),
                          event.get("isError") is True))
            if per_turn:
                per_turn[-1] += 1
        elif kind == "message_end":
            message = event.get("message") or {}
            usage = message.get("usage") or {}
            for key in tokens:
                tokens[key] += usage.get(key) or 0
            # Only the assistant's own messages: a user message carries the whole brief and the diff,
            # and counting it would drown the one number this split exists to report.
            if message.get("role") == "assistant":
                for name, chars in _block_chars(message).items():
                    output_chars[name] += chars
                requests.append({"turn": len(per_turn), "s": _request_seconds(message),
                                 "out": usage.get("output") or 0,
                                 "stop": message.get("stopReason")})

    tool_calls = sum(row["calls"] for row in tools.values())
    unmeasured = sum(row["unmeasured"] for row in tools.values())
    tools_s = round(sum(row["s"] for row in tools.values()), 1)
    batched = sum(1 for count in per_turn if count >= 2)
    timed = [request for request in requests if request["s"] is not None]
    request_seconds = [request["s"] for request in timed]
    slowest_request = max(timed, key=lambda request: request["s"], default=None)
    # Only a stream that fully accounts for the run can be subtracted. Reporting a model share
    # computed as `agent_s - (the calls that happened to have a clock)` would credit the model
    # with a tool's time — wrong in the one direction this line exists to get right. A stream with
    # no turn at all is the other end: pi exits 0 when the provider refused the key, emitting a
    # session header and nothing else, and calling that "all model time" would name the wrong bug.
    # The model share is the sum of the requests pi timed, measured directly. It is *not*
    # `agent_s - tools_s`, which is what an earlier version did and what goby review caught on this
    # change: pi runs a turn's tool calls concurrently, so the sum of their clocks can exceed the
    # wall time they occupied — two overlapping 40s commands add 80s to `tools_s` while taking 40s.
    # Subtracting that from the agent's clock invents model time that never happened.
    model_s = round(sum(request_seconds), 1) if timed else None
    # Whatever is left of the agent's wall clock: tool wall time (which the sum overstates when
    # calls overlap), pi's own startup, the sandbox copy. Two measurements, one subtraction, no
    # claim about which part is which. Absent when a request went untimed, because then the model
    # side is a lower bound and the remainder would swallow the difference.
    other_s = (round(agent_s - model_s, 1)
               if agent_s is not None and model_s is not None
               and len(timed) == len(requests) else None)
    return {
        "agent_s": agent_s,
        "model_s": model_s,
        "tools_s": tools_s,
        "turns": turns,
        "tool_calls": tool_calls,
        "unmeasured_calls": unmeasured,
        "calls_per_turn": {
            "0": sum(1 for count in per_turn if count == 0),
            "1": sum(1 for count in per_turn if count == 1),
            "2+": sum(1 for count in per_turn if count >= 2),
        },
        "batched_turns": batched,
        "requests": {
            "count": len(requests),
            "timed": len(timed),
            "s": round(sum(request_seconds), 1),
            "p50_s": _percentile(request_seconds, 0.50),
            "p95_s": _percentile(request_seconds, 0.95),
            "max_s": max(request_seconds, default=None),
            "slowest_turn": slowest_request["turn"] if slowest_request else None,
            "slowest_out_tokens": slowest_request["out"] if slowest_request else None,
        },
        "other_s": other_s,
        "model_complete": bool(requests) and len(timed) == len(requests),
        "calls": [{"turn": turn, "tool": name,
                   "s": None if seconds is None else round(seconds, 2),
                   "error": error, "subject": subject}
                  for turn, name, seconds, subject, error in calls],
        "tokens": tokens,
        # Characters, by kind of block, from the final assistant messages. Tokens cannot be split this
        # way: `usage.output` is the whole response, and a provider that thinks silently reports
        # thinking there while sending no thinking block back at all.
        "output_chars": output_chars,
        "output_visible_tokens": max(0, sum(output_chars.values()) // CHARS_PER_TOKEN),
        "timeouts": timeouts(events),
        **(_findings(findings)),
        "tool_time": {name: {"calls": row["calls"], "s": round(row["s"], 1),
                             "unmeasured": row["unmeasured"]}
                      for name, row in sorted(tools.items(), key=lambda kv: -kv[1]["s"])},
        "slowest": [{"tool": name, "s": round(seconds, 1), "subject": subject}
                    for _turn, name, seconds, subject, _error in sorted(
                        (call for call in calls if call[2] is not None),
                        key=lambda call: -call[2])[:slowest]],
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
        # A lower bound when pi did not time every response, and marked as one.
        bound = "" if summary["model_complete"] else ">"
        parts.append(f"model{bound}={summary['model_s']:.0f}s")
        if summary["other_s"] is not None and abs(summary["other_s"]) > max(1.0, 0.1 * agent_s):
            parts.append(f"other={summary['other_s']:+.1f}s")
        # The distribution, not the average: what a change can act on is the shape — 43 requests at
        # 1.3s is many cheap round trips, one at 9s is a different problem — and a mean of two
        # clusters hides both.
        served = summary["requests"]
        if served["timed"]:
            spread = f"requests={served['timed']}"
            if served["timed"] != served["count"]:
                spread += f"/{served['count']}"
            spread += (f" p50={served['p50_s']:.1f}s p95={served['p95_s']:.1f}s"
                       f" max={served['max_s']:.1f}s")
            if served["slowest_turn"] is not None:
                spread += (f" (turn {served['slowest_turn']}: "
                           f"{_compact(served['slowest_out_tokens'] or 0)} out)")
            parts.append(spread)
    elif not summary["turns"]:
        parts.append("model=?(no turn ever started)")
    if not tool_calls:
        parts.append("tools=0s (no calls)")
    else:
        breakdown = ", ".join(f"{name} {row['s']:.1f}s/{row['calls']}"
                              for name, row in list(summary["tool_time"].items())[:NAMED_TOOLS])
        hidden = len(summary["tool_time"]) - NAMED_TOOLS
        parts.append(f"tools={summary['tools_s']:.1f}s ({tool_calls} calls: {breakdown}"
                     + (f", +{hidden} more" if hidden > 0 else "") + ")")
    parts.append(f"turns={summary['turns']}")
    if summary["turns"]:
        # The number that decides whether anything can be won from batching: one call per turn is a
        # round trip per probe, and each round trip is a model turn whatever it does.
        batching = f"calls/turn={tool_calls / summary['turns']:.1f}"
        if summary["batched_turns"]:
            batching += f" ({summary['batched_turns']}/{summary['turns']} ran 2+)"
        parts.append(batching)
    if summary["timeouts"]:
        parts.append(f"timeouts={summary['timeouts']}")
    if summary["notices"] is not None:
        # How many budget nudges the reviewer was given, and whether it was cut off at the cap.
        # Both are recorded by the emit extension; the conversation they were injected into is not
        # kept, so this is the only place the answer survives.
        parts.append(f"notices={summary['notices']}")
    if summary["blocked"]:
        parts.append(f"blocked={summary['blocked']}")
    spent = summary["tokens"]
    if any(spent.values()):
        parts.append("tokens " + " ".join(f"{name}={_compact(value)}" for name, value in (
            ("in", spent["input"]), ("out", spent["output"]),
            ("cache-read", spent["cacheRead"]), ("cache-write", spent["cacheWrite"]))))
        # What that output was. The share is exact in characters and approximate in tokens — the
        # same divisor cancels — so only the total carries the approximation mark.
        chars = {name: value for name, value in summary["output_chars"].items() if value}
        if chars:
            total = sum(chars.values())
            shares = ", ".join(f"{name} {100 * value / total:.0f}%"
                               for name, value in sorted(chars.items(), key=lambda kv: -kv[1]))
            visible = summary["output_visible_tokens"]
            hidden = spent["output"] - visible
            parts.append(f"output ~{_compact(visible)} tok ({shares})"
                         # Reasoning a provider does not stream back is real output the content
                         # cannot account for. Saying so is the difference between "it wrote
                         # nothing" and "it wrote tokens we cannot see".
                         + (f", {100 * hidden / spent['output']:.0f}% not in content"
                            if hidden > spent["output"] * 0.05 else ""))
    named = [f'"{call["subject"] or call["tool"]}" {call["s"]:.1f}s' for call in summary["slowest"]]
    if named:
        parts.append("slowest: " + ", ".join(named))
    return "timing " + " ".join(parts)


def call_lines(summary: dict) -> list[str]:
    """One line per tool call, in order, with the turn it belonged to.

    The line above says the ratio; this says what the reviewer did with it. Reading the sequence is
    how "is it batching?" stops being an inference from averages: three calls under one `turn=`
    were one round trip, three turns of one call were three.
    """
    out = []
    for call in summary["calls"]:
        spent = "?" if call["s"] is None else f"{call['s']:.2f}s"
        flag = " !" if call["error"] else ""
        subject = f" {call['subject']}" if call["subject"] else ""
        out.append(f"call {call['turn']:>2} {call['tool']} {spent}{flag}{subject}")
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("events", type=Path)
    parser.add_argument("--agent-seconds", type=float, default=None,
                        help="wall clock around the agent, measured by the caller; the stream has none")
    parser.add_argument("--slowest", type=int, default=2,
                        help="how many of the longest calls to name")
    parser.add_argument("--findings", type=Path, default=None,
                        help="the run's findings.jsonl, for the budget notices it recorded")
    parser.add_argument("--calls", action="store_true",
                        help="print one line per tool call before the summary")
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
    summary = summarise(events, args.agent_seconds, args.slowest, args.findings)
    if args.json:
        print(json.dumps(summary, indent=2))
    elif args.calls:
        print("\n".join(call_lines(summary) + [line(summary)]))
    else:
        print(line(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
