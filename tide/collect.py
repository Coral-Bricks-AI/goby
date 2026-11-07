#!/usr/bin/env python3
"""Turn one sweep's agent runs into the records the filing step reads.

    collect.py --agent-dir out/agent --candidates out/candidates.jsonl --out out/proposals.jsonl

Prints how many records it wrote, so the number in the log is the number that will be filed.

Two things happen here that the agent cannot do for itself:

- **The measurement is the detector's, not the model's.** The record keeps the metric, the
  threshold and the fingerprint the sweep measured, so a proposal cannot restate the premise in
  words that flatter it ("very long file" instead of 1,432 lines).
- **The diff is the harness's, not the model's.** The agent's refactor is read out of the
  sandbox with `git diff` after the run, so "0 functionality change" is a diff a reviewer can
  read, rather than a claim the model made about itself. What the harness cannot see is whether
  that final state is the one the tests ran against, so the proposal carries
  `final_state_tested` and the issue says which it is.

`classify` is the same five-case rule as `cleaners/plan.py`, kept here next to the sweep it
decides for. It is eight lines and it differs in what it counts (proposals, not findings); the
expensive shared thing — the filing machinery — is in `common/issues.py`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def classify(exit_status: int, model_failed: bool, proposals: int) -> str:
    """What to do about one finished run: `ok`, `warn`, `retry`, `wiring` or `harness`.

    `tide.sh` exits 2 for its own refusals — a missing candidate, an unknown provider, a missing
    credential — which no retry can fix. Everything about the *model* is in the event stream,
    because pi exits 0 even when the call fails (`summarize_run.py --status` is the only thing
    that can see it). A run that already emitted proposals is not retried: each one came through
    the emit tool, which refuses a claim without its test runs, and a re-run would spend the
    sweep's budget twice on the same file.
    """
    if exit_status == 2:
        return "wiring"
    if model_failed:
        return "warn" if proposals > 0 else "retry"
    return "harness" if exit_status != 0 else "ok"


def collect(agent_dir: Path, candidates: list[dict]) -> tuple[list[dict], list[str]]:
    """(merged proposals, notes about what was dropped).

    A proposal is kept only for a candidate the sweep actually picked: anything else is a run
    that answered a question nobody asked, and the fingerprint it carries would not match
    either.
    """
    by_key = {(c["check"], c["path"]): c for c in candidates}
    merged: list[dict] = []
    notes: list[str] = []
    for run_dir in sorted(p for p in agent_dir.glob("*") if p.is_dir()):
        path = run_dir / "proposals.jsonl"
        if not path.is_file():
            continue
        diff = run_dir / "refactor.diff"
        diff_text = diff.read_text(errors="replace").strip() if diff.is_file() else ""
        for line in path.read_text(errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except ValueError:
                notes.append(f"{run_dir.name}: unparsable proposal line dropped")
                continue
            key = (str(record.get("check") or ""), str(record.get("path") or ""))
            candidate = by_key.get(key)
            if candidate is None:
                notes.append(f"{run_dir.name}: proposal for {key} is not a candidate")
                continue
            merged.append({
                **record,
                "fingerprint": candidate["fingerprint"],
                "metric": candidate["metric"],
                "threshold": candidate["threshold"],
                "unit": candidate["unit"],
                "diff": diff_text,
                "run_dir": run_dir.name,
            })
    return merged, notes


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    decide = sub.add_parser("classify", help="what to do about one finished run")
    decide.add_argument("--exit", type=int, required=True, dest="exit_status")
    decide.add_argument("--model-failed", action="store_true")
    decide.add_argument("--proposals", type=int, default=0)
    gather = sub.add_parser("collect", help="merge the runs into one proposal file")
    gather.add_argument("--agent-dir", type=Path, required=True)
    gather.add_argument("--candidates", type=Path, required=True)
    gather.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    if args.mode == "classify":
        print(classify(args.exit_status, args.model_failed, args.proposals))
        return 0

    candidates = [json.loads(line) for line in
                  args.candidates.read_text().splitlines() if line.strip()]
    merged, notes = collect(args.agent_dir, candidates)
    for note in notes:
        print(note, file=sys.stderr)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(json.dumps(m) + "\n" for m in merged))
    print(len(merged))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
