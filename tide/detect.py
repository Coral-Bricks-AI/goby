#!/usr/bin/env python3
"""Find the smells a tide sweeps for — mechanically, before any model runs.

    detect.py scan --repo-dir DIR --sha SHA --out FILE \
        [--config .goby/tide.json] [--max-items 3] \
        [--max-file-lines 800] [--max-dir-files 30] [--max-file-imports 40]

Prints a plan to stdout and writes every measurement to `--out` as JSONL. Exits 2 on a
configuration it cannot read, 0 otherwise — finding nothing is a valid sweep.

**Why the measurement is not the model's job.** "This file is 1,432 lines" is arithmetic. Asking
an agent to wander a repository looking for that is slow, unbounded, unrepeatable, and — worst —
untestable: a finding whose premise is a judgement cannot be checked by the human who reads the
issue. So the detector decides *what* is a smell and the agent decides *how to remove it*. The
premise in the issue is then a number with a unit, and the same number appears next week.

**What is deliberately not here.** Anything needing a parser or a language server: nesting depth,
function length, duplication. Each is a real smell and each needs a toolchain the base image does
not carry, so it belongs behind a per-repository tool, not in a scheduled sweep whose premise is
"works in every repository with no setup". A repository that wants more checks installs its own
image — the workflow takes a digest.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

CONFIG_PATH = ".goby/tide.json"

# Generated, vendored and minified files legitimately break every threshold here, and a sweep
# that files an issue about a 12k-line generated client gets uninstalled the same week. These are
# built in because they are not opinions; `.goby/tide.json`'s `ignore` adds to them.
BUILT_IN_IGNORE = (
    ".git/**",
    "node_modules/**",
    "vendor/**",
    "dist/**",
    "build/**",
    "**/*.lock",
    "**/package-lock.json",
    "**/bun.lock",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.snap",
    "**/*.svg",
    "**/*.csv",
    "**/*.generated.*",
)

# A debt marker, but only where one is written: the marker has to follow a comment delimiter on
# the same line. A bare `\bTODO\b` looks right and is not — `L.TODO` is a status constant in
# www's `ml/platform/infra/retirement.py`, twenty times in one file, and every one of them would
# have been filed as debt. The agent can reason about the stragglers this misses (a `"// TODO"`
# inside a string); it cannot un-file a wrong measurement that was never debt.
COMMENT_MARKER = re.compile(r"(?://|#|--|/\*|\*|<!--)\s*(?P<word>TODO|FIXME|HACK|XXX)\b")

# Test paths, for the one threshold that is measured per kind. A 900-line test file and a 900-line
# source file are different smells: splitting a table of cases buys less than splitting a module
# with logic in it. Built in rather than configurable because it is a convention, not a policy, and
# a repository that disagrees can `ignore` the path or record it under `known`.
TEST_PATH_PATTERNS = (
    "**/test_*.py", "**/*_test.py", "**/tests/**", "**/__tests__/**",
    "**/testdata/**", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx",
)

# An import line, as the languages a repository might be written in spell it. Counting lines
# rather than parsing is the point: the number is a hint, not a claim about the module graph.
IMPORT_LINE = re.compile(
    r"^\s*(?:import\s|from\s+\S+\s+import\s|use\s+\w|#include\s|require\(|"
    r"(?:const|let|var)\s+\w+\s*=\s*require\()")

# A measurement needs a size and a name; both are reported. Beyond this a file is data or a
# minified bundle, not source somebody will refactor.
MAX_BYTES = 2_000_000
SAMPLE_BYTES = 8192

# The keys `.goby/tide.json` may carry. `_comment` is allowed because a committed config wants to
# explain itself and the sweep should not be the thing that forbids it.
KNOWN_KEYS = ("_comment", "ignore", "known")

HUMAN_NAME = {
    "max_file_lines": "one file, too many lines",
    "max_dir_files": "one directory, too many files",
    "max_file_imports": "one file, too many imports",
    "max_todos": "one file, too many debt markers",
    "todo_age": "a debt marker old enough to be a decision nobody made",
}


@dataclass(frozen=True)
class Thresholds:
    max_file_lines: int
    max_dir_files: int
    max_file_imports: int
    max_todos: int = 10
    max_todo_age_days: int = 365
    max_test_file_lines: int = 1500


@dataclass(frozen=True)
class Known:
    """A smell a human looked at and decided to live with.

    `reason` is required, because the reason is printed: an issue whose problem is already
    known is noise, and an ignore list nobody can explain is the same list a year later.
    """

    check: str
    path: str
    reason: str


@dataclass
class Config:
    ignore: tuple[str, ...] = ()
    known: tuple[Known, ...] = ()
    notes: list[str] = field(default_factory=list)


def load_config(path: Path) -> Config:
    """The repository's own ignore list and known non-findings.

    A missing file is the normal case (a repository that has not decided anything yet). A file
    that cannot be parsed is an error and stops the sweep: silently sweeping with defaults is
    how a `known` entry someone just added has no effect, which is worse than a red task.
    """
    if not path.is_file():
        return Config()
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise SystemExit(f"error: cannot read {path}: {e}")
    if not isinstance(raw, dict):
        raise SystemExit(f"error: {path} must be a JSON object")
    # A key this schema does not know is a typo or a bare entry pasted as the whole file, and both
    # mean the decision its author recorded has no effect. Silently treating that as an empty
    # config is how a smell someone decided to live with is filed again every sweep — the failure
    # the file exists to prevent, with the reader believing they had already prevented it.
    unknown = sorted(set(raw) - set(KNOWN_KEYS))
    if unknown:
        raise SystemExit(f"error: {path}: unknown key(s) {', '.join(unknown)}; this file takes "
                         f"{', '.join(sorted(KNOWN_KEYS))}")
    ignore = raw.get("ignore") or []
    known_raw = raw.get("known") or []
    if not isinstance(ignore, list) or not all(isinstance(i, str) for i in ignore):
        raise SystemExit(f"error: {path}: `ignore` must be a list of strings")
    if not isinstance(known_raw, list):
        raise SystemExit(f"error: {path}: `known` must be a list of objects")
    known = []
    for entry in known_raw:
        if not isinstance(entry, dict) or not entry.get("check") or not entry.get("path"):
            raise SystemExit(f"error: {path}: every `known` entry needs `check` and `path`")
        if entry["check"] not in HUMAN_NAME:
            raise SystemExit(f"error: {path}: unknown check {entry['check']!r} "
                             f"(known checks: {', '.join(sorted(HUMAN_NAME))})")
        if not entry.get("reason"):
            # Required, not decoration: the reason is what the next person reads, and a list of
            # silences nobody can explain is how a real smell stays hidden for a year.
            raise SystemExit(f"error: {path}: known entry for {entry['path']} needs a `reason`")
        known.append(Known(str(entry["check"]), str(entry["path"]).strip("/"),
                           str(entry["reason"])))
    return Config(tuple(ignore), tuple(known))


def matches(path: str, pattern: str) -> bool:
    """A glob over repo-relative paths, where `*` also crosses a directory.

    `**/x` is also tried without its prefix, so a pattern written for nested files still catches
    the top-level one — the alternative is a repository that writes `**/*.min.js`, believes it,
    and files an issue about `app.min.js`.
    """
    candidates = [pattern]
    if pattern.startswith("**/"):
        candidates.append(pattern[3:])
    for candidate in candidates:
        if fnmatch.fnmatch(path, candidate) or path == candidate.rstrip("/"):
            return True
    return False


def ignored(path: str, patterns: tuple[str, ...]) -> bool:
    return any(matches(path, p) for p in (*BUILT_IN_IGNORE, *patterns))


def fingerprint(check: str, path: str) -> str:
    """The detector's own identity for a smell: which check, on which path.

    Not the model's title, which is what the cleaner fingerprints. A cleaner reports events that
    are distinct by construction; a tide re-measures the same file every week, so a key that
    contains a sentence the model wrote would file the same 1,432-line file again the moment the
    sentence changed. Recurrence is handled by reading *open* issues only, not by re-wording.
    """
    return hashlib.sha256(f"{check}|{path}".encode()).hexdigest()[:12]


def undecodable(path: str) -> bool:
    return any("\ud800" <= char <= "\udfff" for char in path)


def tracked_files(repo_dir: Path) -> list[str]:
    """Every file git knows about, repo-relative, undecodable names dropped.

    `git ls-files` rather than a walk: it skips `.gitignore`d build output for free, which is
    most of what a naive walk would report. `-z` because a path is bytes on disk and a newline
    in a filename is legal.
    """
    try:
        done = subprocess.run(["git", "-C", str(repo_dir), "ls-files", "-z"],
                              capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise SystemExit(f"error: cannot list tracked files in {repo_dir}: {e}")
    out = []
    for raw in done.stdout.split(b"\0"):
        if not raw:
            continue
        path = raw.decode("utf-8", "surrogateescape")
        if not undecodable(path):
            out.append(path)
    return out


def read_text(root: Path, path: str) -> str | None:
    """The file's text, or None when it is binary, oversized or unreadable.

    Nothing is filtered by extension: a `Makefile` and a `Dockerfile` are source, and a
    `.json` schema can be a smell. What is filtered is what cannot be counted meaningfully.
    """
    target = root / path
    try:
        with target.open("rb") as handle:
            head = handle.read(SAMPLE_BYTES)
            if b"\0" in head:
                return None
            rest = handle.read(MAX_BYTES - len(head) + 1)
    except OSError:
        return None
    if len(head) + len(rest) > MAX_BYTES:
        return None
    return (head + rest).decode("utf-8", "replace")


def line_count(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def is_test_path(path: str) -> bool:
    return any(matches(path, pattern) for pattern in TEST_PATH_PATTERNS)


def measure(files: list[str], read: Callable[[str], str | None], thresholds: Thresholds,
            config: Config, age_of: Callable[[str, list[int]], int | None] | None = None
            ) -> list[dict]:
    """Every over-threshold measurement, sorted so the report does not move between runs.

    `age_of` is the one measurement this file cannot make alone: how old a marker is lives in git
    history, not in the tree, so it is injected (and `None` when no history is available).
    """
    found: list[dict] = []
    dirs: dict[str, int] = {}
    for path in files:
        if ignored(path, config.ignore):
            continue
        parent = os.path.dirname(path)
        if parent:
            dirs[parent] = dirs.get(parent, 0) + 1
        text = read(path)
        if text is None:
            continue
        lines = line_count(text)
        limit = thresholds.max_test_file_lines if is_test_path(path) else thresholds.max_file_lines
        if lines > limit:
            found.append({"check": "max_file_lines", "path": path, "metric": lines,
                          "threshold": limit, "unit": "lines",
                          "facts": {"lines": lines,
                                    "kind": "test" if limit != thresholds.max_file_lines
                                            else "source"}})
        imports = sum(1 for line in text.splitlines() if IMPORT_LINE.match(line))
        if imports > thresholds.max_file_imports:
            found.append({"check": "max_file_imports", "path": path, "metric": imports,
                          "threshold": thresholds.max_file_imports, "unit": "imports",
                          "facts": {"imports": imports}})
        markers = [(number, match.group("word"))
                   for number, line in enumerate(text.splitlines(), 1)
                   if (match := COMMENT_MARKER.search(line))]
        if len(markers) > thresholds.max_todos:
            found.append({"check": "max_todos", "path": path, "metric": len(markers),
                          "threshold": thresholds.max_todos, "unit": "markers",
                          "facts": {"markers": len(markers),
                                    "first": f"line {markers[0][0]}: {markers[0][1]}"}})
        if markers and age_of is not None:
            age = age_of(path, [number for number, _ in markers])
            if age is not None and age > thresholds.max_todo_age_days:
                found.append({"check": "todo_age", "path": path, "metric": age,
                              "threshold": thresholds.max_todo_age_days, "unit": "days",
                              "facts": {"oldest_days": age, "markers": len(markers)}})
    for directory, count in dirs.items():
        if count > thresholds.max_dir_files:
            found.append({"check": "max_dir_files", "path": directory, "metric": count,
                          "threshold": thresholds.max_dir_files, "unit": "files",
                          "facts": {"files": count}})
    return sorted(found, key=lambda c: (c["check"], c["path"]))


def has_history(repo_dir: Path) -> bool:
    """Whether the clone carries more than the commit being swept.

    A one-commit clone cannot answer the age question: every line blames to the head, so the check
    would report 0 days forever and look like a repository with no old debt. Skipping it loudly is
    the only honest answer, and it is why `TIDE_HISTORY_DEPTH` exists.
    """
    try:
        done = subprocess.run(["git", "-C", str(repo_dir), "rev-list", "--count", "HEAD"],
                              capture_output=True, text=True)
    except OSError:
        return False
    if done.returncode != 0:
        return False
    return int(done.stdout.strip() or 0) > 1


def blame_ages(repo_dir: Path, path: str, lines: list[int],
               now: int | None = None) -> int | None:
    """The age in days of the oldest of `lines`, from `git blame`; None when git cannot say.

    Porcelain output has one header per line (`<sha> <orig> <final> [<count>]`) and then the
    commit's fields, including `committer-time`. One blame call per file with markers, because the
    alternative — one call per line — is the same work with more process starts.

    A shallow clone stops at its boundary commit: every line older than the fetched depth is
    attributed to it, so the age is *capped* at the window rather than wrong in a direction that
    matters. With the shipped `TIDE_HISTORY_DEPTH` that window is weeks-to-months, and an age over
    the threshold is still an age over the threshold.
    """
    if not lines:
        return None
    try:
        done = subprocess.run(
            ["git", "-C", str(repo_dir), "blame", "--line-porcelain", "--", path],
            capture_output=True, text=True)
    except OSError:
        return None
    if done.returncode != 0:
        return None
    wanted, ages = set(lines), {}
    current, stamp = None, None
    for line in done.stdout.splitlines():
        head = line.split(" ", 3)
        if len(head) == 4 and len(head[0]) == 40 and head[2].isdigit():
            current, stamp = int(head[2]), stamp
        elif line.startswith("committer-time "):
            stamp = int(line.split(" ", 1)[1])
        elif line.startswith("\t") and current in wanted and stamp is not None:
            ages[current] = stamp
    if not ages:
        return None
    oldest = min(ages.values())
    return max(0, ((now or int(time.time())) - oldest) // 86400)


def apply_known(candidates: list[dict], config: Config) -> tuple[list[dict], list[dict]]:
    """(candidates to file, the ones a human already decided about).

    The marker stays on every candidate, known or not: an issue filed before someone added the
    `known` line must still count as "this smell is still here", or the sweep would close it
    with a "resolved" comment that is not true.
    """
    by_key = {(k.check, k.path): k for k in config.known}
    kept, suppressed = [], []
    for candidate in candidates:
        known = by_key.get((candidate["check"], candidate["path"]))
        if known is None:
            kept.append(candidate)
            continue
        suppressed.append({**candidate, "known_reason": known.reason})
    return kept, suppressed


def stale_known(candidates: list[dict], config: Config) -> list[dict]:
    """Known entries that no longer fire: the ignore list is allowed to go out of date, and a
    stale entry is worth one line in the log so it does not hide a smell forever."""
    firing = {(c["check"], c["path"]) for c in candidates}
    return [{"check": k.check, "path": k.path,
             "reason": "no longer over its threshold; the entry can be removed"}
            for k in config.known if (k.check, k.path) not in firing]


def rotate(candidates: list[dict], max_items: int, sha: str) -> list[dict]:
    """Which of the over-threshold smells this sweep gets to spend model calls on.

    Worst first, because a 4,000-line file is a better use of one call than a 820-line one. Ties
    are broken by a hash of the commit, check and path: without it the cap would always spend
    the same call on the same alphabetically-first file, and a repository with forty smells
    would never hear about thirty-eight of them. With it, the same commit picks the same
    candidates (a re-run is reproducible) and the next sweep picks different ones.
    """
    def key(candidate: dict) -> tuple[float, str]:
        ratio = candidate["metric"] / max(candidate["threshold"], 1)
        tie = hashlib.blake2b(f"{sha}|{candidate['check']}|{candidate['path']}".encode(),
                              digest_size=8).hexdigest()
        return (-ratio, tie)

    return sorted(candidates, key=key)[:max_items]


def scan(repo_dir: Path, sha: str, thresholds: Thresholds, config: Config,
         max_items: int, files: list[str] | None = None,
         read: Callable[[str], str | None] | None = None,
         age_of: Callable[[str, list[int]], int | None] | None = None
         ) -> tuple[dict, list[dict]]:
    """(the plan, every measurement).

    The second half is not `plan["picked"]`: the picked list is the subset this sweep may spend a
    model call on, and the measurements it could not afford are still measurements. `--close-gone`
    reads the second half, so a smell over the model budget is not mistaken for a smell that went
    away — which is what closing an issue on it would say.
    """
    files = tracked_files(repo_dir) if files is None else files
    measure_read = read or (lambda path: read_text(repo_dir, path))
    if age_of is not None:
        measure_age, history = age_of, "injected"
    elif has_history(repo_dir):
        measure_age, history = (lambda path, lines: blame_ages(repo_dir, path, lines)), "clone"
    else:
        measure_age, history = None, "none (one-commit clone; todo_age skipped)"
    everything = measure(files, measure_read, thresholds, config, measure_age)
    for candidate in everything:
        candidate["fingerprint"] = fingerprint(candidate["check"], candidate["path"])
    firing, suppressed = apply_known(everything, config)
    picked = rotate(firing, max_items, sha)
    plan = {
        "sha": sha,
        "files": len(files),
        "candidates": len(everything),
        "firing": len(firing),
        "history": history,
        "suppressed": suppressed,
        "stale_known": stale_known(everything, config),
        "picked": picked,
        "thresholds": {"max_file_lines": thresholds.max_file_lines,
                       "max_test_file_lines": thresholds.max_test_file_lines,
                       "max_dir_files": thresholds.max_dir_files,
                       "max_file_imports": thresholds.max_file_imports,
                       "max_todos": thresholds.max_todos,
                       "max_todo_age_days": thresholds.max_todo_age_days},
    }
    return plan, everything


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    scan_cmd = sub.add_parser("scan", help="measure the checkout and print the plan")
    scan_cmd.add_argument("--repo-dir", type=Path, required=True)
    scan_cmd.add_argument("--sha", required=True)
    scan_cmd.add_argument("--out", type=Path, required=True,
                          help="every measurement, one JSON object per line; this is what the "
                               "filing step closes issues from, so it must not be the subset")
    scan_cmd.add_argument("--candidates", type=Path, default=None,
                          help="the ones this sweep will scan (default: nowhere)")
    scan_cmd.add_argument("--config", type=Path, default=None)
    scan_cmd.add_argument("--max-items", type=int, default=3)
    scan_cmd.add_argument("--max-file-lines", type=int, default=800)
    scan_cmd.add_argument("--max-test-file-lines", type=int, default=1500)
    scan_cmd.add_argument("--max-dir-files", type=int, default=30)
    scan_cmd.add_argument("--max-file-imports", type=int, default=40)
    scan_cmd.add_argument("--max-todos", type=int, default=10)
    scan_cmd.add_argument("--max-todo-age-days", type=int, default=365)
    args = ap.parse_args(argv)

    thresholds = Thresholds(args.max_file_lines, args.max_dir_files, args.max_file_imports,
                            args.max_todos, args.max_todo_age_days,
                            args.max_test_file_lines)
    config = load_config(args.config or (args.repo_dir / CONFIG_PATH))
    plan, measured = scan(args.repo_dir, args.sha, thresholds, config, args.max_items)

    # Every measurement, not the picked subset: the filing step closes an open issue whose smell
    # is no longer in this file, so a smell that was merely over today's model budget would be
    # closed as "resolved" if this were only the candidates the sweep could afford.
    args.out.write_text("".join(json.dumps(c) + "\n" for c in
                                sorted(measured, key=lambda c: (c["check"], c["path"]))))
    if args.candidates:
        args.candidates.write_text("".join(json.dumps(c) + "\n" for c in plan["picked"]))
    # The plan is the log: what was measured, what a human already decided, and what this sweep
    # is allowed to spend a model call on. Nothing downstream has to re-derive it.
    print(json.dumps({**plan, "picked": [
        {k: c[k] for k in ("check", "path", "metric", "threshold", "fingerprint")}
        for c in plan["picked"]]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
