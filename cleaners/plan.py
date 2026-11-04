#!/usr/bin/env python3
"""The two decisions the entrypoint used to make in shell.

    git ls-files -- '*HUNT.md' | plan.py picked --changed FILE --max 4 [--before-unknown]
    plan.py collect --agent-dir DIR --out FILE

`picked` turns "which files carry a `HUNT.md`" plus "which files this push changed" into the
directories to hunt, printed one per line. What it ignored goes to stderr, where the task log
keeps it. When more components changed than the cap allows, the ones with the most changed
files win: the push moved them the furthest, so a defect is likeliest there.

`collect` concatenates every hunt's findings into one file and prints how many findings that
is, so the number in the log is the number that will be filed.

Both used to be shell — a `sed`/`awk` pair and a glob — and both were wrong in review: a
root-level `HUNT.md` was read as a component that could never match anything, and the glob's
depth was questioned. Shell cannot be tested here, and this decides whether a push is hunted
at all.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

SUFFIX = "/HUNT.md"


def components(hunt_files: list[str]) -> tuple[list[str], list[str]]:
    """(component directories, notes about what was ignored), both sorted/stable.

    A component is a *directory* that contains a `HUNT.md`. A `HUNT.md` at the repository
    root would mean "hunt everything", which is the one scope this design exists to avoid,
    so it is named and dropped rather than turned into a component.
    """
    seen: set[str] = set()
    found: list[str] = []
    notes: list[str] = []
    for raw in hunt_files:
        path = raw.strip()
        if not path:
            continue
        if path == "HUNT.md":
            notes.append("ignoring the root-level HUNT.md: a component is a directory, "
                         "not the whole repo")
            continue
        if not path.endswith(SUFFIX):
            notes.append(f"ignoring {path}: a component is <directory>{SUFFIX}")
            continue
        directory = path[: -len(SUFFIX)]
        if directory in seen:
            continue
        seen.add(directory)
        found.append(directory)
    return sorted(found), notes


def touched(directory: str, changed: list[str]) -> bool:
    """A changed file belongs to a component when it is inside it — `a/b` not `a/bc`."""
    prefix = directory + "/"
    return any(path == directory or path.startswith(prefix) for path in changed)


def rank(directory: str, changed: list[str], sha: str = "") -> tuple[int, str]:
    """Sort key for a component this push touched: most changed files first.

    The cap used to slice the alphabet, which made the component that got dropped an accident
    of its name — a gateway change was skipped while three backend components were hunted. The
    count is how far the push moved each component, so the busier one is the better bet.

    Ties are broken by a hash of the commit, the component and the files it changed: a one-line
    change to two components is the common case, and an alphabetical tie-break would put the
    same component first every time. The commit is part of the key on purpose — two pushes that
    touch the same five paths would otherwise rank identically, and the cap would drop the same
    component forever. The key is still stable for one push, so a re-run of the same commit
    hunts the same components.
    """
    prefix = directory + "/"
    inside = sorted(p for p in changed if p == directory or p.startswith(prefix))
    key = "\n".join((sha, directory, *inside))
    tie = hashlib.blake2b(key.encode(), digest_size=8).hexdigest()
    return (-len(inside), tie)


def picked(components_list: list[str], changed: list[str], max_components: int,
           before_known: bool, sha: str = "") -> tuple[list[str], str]:
    """(the components to hunt, one line saying why)."""
    if before_known:
        chosen = sorted((c for c in components_list if touched(c, changed)),
                        key=lambda directory: rank(directory, changed, sha))
        note = f"{len(changed)} changed path(s) → {len(chosen)}/{len(components_list)} component(s)"
    else:
        # The push did not name its predecessor, so the diff is unknown. "We do not know what
        # changed" is not "nothing did".
        chosen = list(components_list)
        note = f"change set unknown; treating the push as touching all {len(chosen)} component(s)"
    if len(chosen) > max_components:
        note += f"; capped {len(chosen)} to {max_components}"
        if before_known:
            # Which component lost the cap is the one question the log has to answer when a
            # defect ships uncaught.
            note += f" (dropped: {', '.join(chosen[max_components:])})"
        chosen = chosen[:max_components]
    return chosen, note


def classify(exit_status: int, model_failed: bool, findings: int) -> str:
    """What to do about one finished hunt: `ok`, `warn`, `retry`, `wiring` or `harness`.

    `hunt.sh` exits 2 for its own refusals — a missing charter, an unknown provider, a missing
    credential — which no retry can fix, and retrying one reports a broken component as a
    clean hunt. Everything else about the *model* is in the event stream, because pi exits 0
    even when the call fails (verified against a 401 and against a refused connection: both
    exit 0 with `stopReason=error`). A non-zero exit that is not `2` and is not accompanied by
    a failed turn is therefore the harness, not the model.

    A run that already emitted findings is not retried however it failed: each finding came
    through the emit tool, which refuses one without its repro and its flip, and re-hunting
    the component would file the same defects again under reworded titles.
    """
    if exit_status == 2:
        return "wiring"
    if model_failed:
        return "warn" if findings > 0 else "retry"
    return "harness" if exit_status != 0 else "ok"


def collect(agent_dir: Path, out: Path) -> int:
    """Write every `<component>/findings.jsonl` into `out`; return the number of findings."""
    files = sorted(agent_dir.glob("*/findings.jsonl"))
    out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out.open("w") as sink:
        for path in files:
            text = path.read_text()
            if not text:
                continue
            sink.write(text if text.endswith("\n") else text + "\n")
            count += sum(1 for line in text.splitlines() if line.strip())
    return count


def read_changed(path: Path) -> list[str]:
    return [line.strip() for line in path.read_text().splitlines() if line.strip()]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    pick = sub.add_parser("picked", help="read HUNT.md paths on stdin")
    pick.add_argument("--changed", type=Path, required=True)
    pick.add_argument("--max", type=int, default=4)
    pick.add_argument("--sha", default="", help="the commit being hunted; breaks ties so two "
                                              "pushes over the same paths do not drop the same "
                                              "component forever")
    pick.add_argument("--before-unknown", action="store_true")
    decide = sub.add_parser("classify", help="what to do about one finished hunt")
    decide.add_argument("--exit", type=int, required=True, dest="exit_status")
    decide.add_argument("--model-failed", action="store_true")
    decide.add_argument("--findings", type=int, default=0)
    gather = sub.add_parser("collect", help="concatenate findings and print the count")
    gather.add_argument("--agent-dir", type=Path, required=True)
    gather.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    if args.mode == "classify":
        print(classify(args.exit_status, args.model_failed, args.findings))
        return 0
    if args.mode == "collect":
        print(collect(args.agent_dir, args.out))
        return 0

    found, notes = components(sys.stdin.read().splitlines())
    for note in notes:
        print(note, file=sys.stderr)
    if not found:
        print("no component carries a HUNT.md", file=sys.stderr)
        return 0
    chosen, note = picked(found, read_changed(args.changed), args.max,
                          before_known=not args.before_unknown, sha=args.sha)
    print(note, file=sys.stderr)
    for directory in chosen:
        print(directory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
