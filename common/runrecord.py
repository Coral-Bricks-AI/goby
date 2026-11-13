#!/usr/bin/env python3
"""One run's numbers as a record, for the marker a review leaves in its body.

    runrecord.py /workspace/out/agent --agent-seconds 118 --model coral/deepseek-v4.1-flash-fast

Prints one compact JSON object: the wall-clock split, per-tool time, the per-request
distribution, the token classes, the price, and the counters that say the run was cut short.

The publisher adds the two fields only it can know — goby's version, and whether the run was
complete — and wraps the result in the `<!-- goby-run … -->` marker whose grammar lives in
`src/core/record.ts`. Keeping the grammar in one file is what lets a reader parse what a
writer wrote without the two drifting.

Why a marker at all: these numbers used to exist only in the Actions job summary, which has no
API and expires with the log, so "what does a review cost" was answerable for ninety days out
of a zip file. The marker is the same numbers, in the one place a review is kept forever.

Nothing here is measured twice. The split comes from `timing.summarise` and the price from
`usage.price`, the same two functions the log line and the job summary use, so the record and
the line a human reads cannot disagree.
"""
import argparse
import json
import sys
from pathlib import Path

import timing
import usage

# The record's own version, bumped when a field changes meaning or leaves. A reader that knows
# this number can read every record that carries it; a field added later is not a new schema.
SCHEMA = 1
PRODUCT = "review"


def count_tokens(tokens: dict) -> dict:
    """The stream's camelCase class names, as the record's snake_case ones.

    Renamed rather than passed through because the record is a public surface: `cache_read` is
    what a consumer writes in a query, and `cacheRead` is what pi happens to call it.
    """
    return {
        "input": tokens.get("input") or 0,
        "output": tokens.get("output") or 0,
        "cache_read": tokens.get("cacheRead") or 0,
        "cache_write": tokens.get("cacheWrite") or 0,
        "reasoning": tokens.get("reasoning") or 0,
    }


def record(agent_dir: Path, agent_seconds: float | None = None, model: str | None = None,
           catalog_path=None) -> dict:
    """The record for one run, from the directory the agent wrote.

    A run with no event stream has no measurement, which is a fact about the run and not a
    reason to print zeros: a stated 0 is a measurement, and a wrong one costs more than an
    absent field.
    """
    base: dict = {"schema": SCHEMA, "product": PRODUCT, "model": model}
    events_path = Path(agent_dir) / "events.jsonl"
    events = timing.read_events(events_path) if events_path.is_file() else []
    if not events:
        return {**base, "measured": False,
                "note": "no event stream: the model/tool split is unavailable"}
    summary = timing.summarise(events, agent_seconds, 0, Path(agent_dir) / "findings.jsonl")
    requests = summary["requests"]
    cost = usage.price(model or "", summary["tokens"], catalog_path)
    return {
        **base,
        "measured": True,
        # The wall clock, split the way the log line splits it. `other_s` is null when a request
        # went untimed: the remainder would then swallow the difference and read as a third
        # measurement that was never taken.
        "agent_s": summary["agent_s"],
        "model_s": summary["model_s"],
        "tools_s": summary["tools_s"],
        "other_s": summary["other_s"],
        "turns": summary["turns"],
        "tool_calls": summary["tool_calls"],
        # Covers every tool the run used, including the ones that recorded no time, which is how
        # a call that never returned still appears here with a count and no seconds.
        "tool_s": {name: row["s"] for name, row in summary["tool_time"].items()},
        "requests": {
            "count": requests["count"],
            "p50_s": requests["p50_s"],
            "p95_s": requests["p95_s"],
            "max_s": requests["max_s"],
        },
        # A killed command and a budget that ran out are the two ways a fast run is fast for the
        # wrong reason; `complete` is the publisher's answer about the scan, `timeouts` is the
        # count of commands this run killed.
        "timeouts": summary["timeouts"],
        "blocked": summary["blocked"],
        "tokens": count_tokens(summary["tokens"]),
        "cost": {"cents": cost["billed_cents"], "usd": cost["billed_usd"], "note": cost["note"]},
    }


def dump(value: dict) -> str:
    """Compact and key-sorted: the marker is read by machines, and a stable byte order makes two
    runs with the same numbers compare equal."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("agent_dir", type=Path,
                        help="the run's agent directory, holding events.jsonl and findings.jsonl")
    parser.add_argument("--agent-seconds", type=float, default=None,
                        help="wall clock around the agent, measured by the caller")
    parser.add_argument("--model", default=None, help="the model the run used, for pricing")
    parser.add_argument("--models-json", default=None, help="model catalog to price from")
    args = parser.parse_args(argv)
    print(dump(record(args.agent_dir, args.agent_seconds, args.model, args.models_json)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
