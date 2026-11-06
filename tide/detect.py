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

# An import line, as the languages a repository might be written in spell it. Counting lines
# rather than parsing is the point: the number is a hint, not a claim about the module graph.
IMPORT_LINE = re.compile(
    r"^\s*(?:import\s|from\s+\S+\s+import\s|use\s+\w|#include\s|require\(|"
    r"(?:const|let|var)\s+\w+\s*=\s*require\()")

# A measurement needs a size and a name; both are reported. Beyond this a file is data or a
# minified bundle, not source somebody will refactor.
MAX_BYTES = 2_000_000
SAMPLE_BYTES = 8192

HUMAN_NAME = {
    "max_file_lines": "one file, too many lines",
    "max_dir_files": "one directory, too many files",
    "max_file_imports": "one file, too many imports",
}


@dataclass(frozen=True)
class Thresholds:
    max_file_lines: int
    max_dir_files: int
    max_file_imports: int


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


def measure(files: list[str], read: Callable[[str], str | None], thresholds: Thresholds,
            config: Config) -> list[dict]:
    """Every over-threshold measurement, sorted so the report does not move between runs."""
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
        if lines > thresholds.max_file_lines:
            found.append({"check": "max_file_lines", "path": path, "metric": lines,
                          "threshold": thresholds.max_file_lines, "unit": "lines",
                          "facts": {"lines": lines}})
        imports = sum(1 for line in text.splitlines() if IMPORT_LINE.match(line))
        if imports > thresholds.max_file_imports:
            found.append({"check": "max_file_imports", "path": path, "metric": imports,
                          "threshold": thresholds.max_file_imports, "unit": "imports",
                          "facts": {"imports": imports}})
    for directory, count in dirs.items():
        if count > thresholds.max_dir_files:
            found.append({"check": "max_dir_files", "path": directory, "metric": count,
                          "threshold": thresholds.max_dir_files, "unit": "files",
                          "facts": {"files": count}})
    return sorted(found, key=lambda c: (c["check"], c["path"]))


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
         read: Callable[[str], str | None] | None = None) -> tuple[dict, list[dict]]:
    """(the plan, every measurement).

    The second half is not `plan["picked"]`: the picked list is the subset this sweep may spend a
    model call on, and the measurements it could not afford are still measurements. `--close-gone`
    reads the second half, so a smell over the model budget is not mistaken for a smell that went
    away — which is what closing an issue on it would say.
    """
    files = tracked_files(repo_dir) if files is None else files
    measure_read = read or (lambda path: read_text(repo_dir, path))
    everything = measure(files, measure_read, thresholds, config)
    for candidate in everything:
        candidate["fingerprint"] = fingerprint(candidate["check"], candidate["path"])
    firing, suppressed = apply_known(everything, config)
    picked = rotate(firing, max_items, sha)
    plan = {
        "sha": sha,
        "files": len(files),
        "candidates": len(everything),
        "firing": len(firing),
        "suppressed": suppressed,
        "stale_known": stale_known(everything, config),
        "picked": picked,
        "thresholds": {"max_file_lines": thresholds.max_file_lines,
                       "max_dir_files": thresholds.max_dir_files,
                       "max_file_imports": thresholds.max_file_imports},
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
    scan_cmd.add_argument("--max-dir-files", type=int, default=30)
    scan_cmd.add_argument("--max-file-imports", type=int, default=40)
    args = ap.parse_args(argv)

    thresholds = Thresholds(args.max_file_lines, args.max_dir_files, args.max_file_imports)
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
