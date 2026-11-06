#!/usr/bin/env python3
"""Which model this container can actually run.

    model_check.py --models-dir models --model coral/x --fallback coral/x

Prints the model to scan with and exits 0; prints why it cannot scan and exits 3. The
entrypoint runs this before any clone, because a missing credential must fail in one log
line rather than after a task start, a checkout and a sandbox copy — and because a scan that
cannot call a model must never look like a scan that found nothing.

A provider is usable when every variable its models file interpolates is set — **except the
ones this harness supplies itself** (`CLEANERS_*`, `PI_*`). Those do not exist yet when the
check runs, and they are not credentials: `models/coral.json` interpolates
`CLEANERS_SESSION_ID` for spend attribution, and counting it as a credential refused every
default scan.

This lives in Python, not in the shell, because it decides whether the system does anything
at all, and shell arithmetic on a JSON file cannot be tested.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# pi's models.json interpolates `$NAME` **and** `${NAME}`. Matching only the bare form read a
# file that used braces as one with no credentials: a provider whose key was unset looked usable,
# so the required fallback never ran and the scan failed after the clone instead of before it.
VAR = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)")
# Names the harness sets for the scan itself. A models file may interpolate them; they are
# config, not credentials.
HARNESS_PREFIXES = ("CLEANERS_", "PI_")


def interpolated(models_file: Path) -> set[str]:
    return {braced or bare for braced, bare in VAR.findall(models_file.read_text())}


def credential_vars(models_file: Path) -> set[str]:
    return {v for v in interpolated(models_file) if not v.startswith(HARNESS_PREFIXES)}


def models_file(models_dir: Path, provider: str) -> Path | None:
    path = models_dir / f"{provider}.json"
    return path if path.is_file() else None


def missing(models_dir: Path, model: str, env: dict[str, str]) -> list[str] | None:
    """The unset credential variables for this model, or None when the provider has no file."""
    path = models_file(models_dir, model.split("/", 1)[0])
    if path is None:
        return None
    return sorted(v for v in credential_vars(path) if not env.get(v))


def choose(models_dir: Path, model: str, fallback: str,
           env: dict[str, str]) -> tuple[str | None, str]:
    """(the model to scan with, why not when there is none)."""
    reasons = []
    for candidate, label in ((model, "model"), (fallback, "fallback")):
        gone = missing(models_dir, candidate, env)
        if gone is None:
            reasons.append(f"{label} {candidate}: no models/{candidate.split('/', 1)[0]}.json")
            continue
        if not gone:
            return candidate, ""
        reasons.append(f"{label} {candidate}: {', '.join(gone)} unset")
    return None, "; ".join(reasons)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", type=Path, default=Path("/opt/cleaners/models"))
    ap.add_argument("--model", required=True)
    ap.add_argument("--fallback", required=True)
    args = ap.parse_args(argv)

    model, why = choose(args.models_dir, args.model, args.fallback, dict(os.environ))
    if model is None:
        print(f"error: no model credential ({why})", file=sys.stderr)
        return 3
    if model != args.model:
        print(f"no credential for {args.model}; falling back to {model}", file=sys.stderr)
    print(model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
