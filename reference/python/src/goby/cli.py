"""Command line entry point.

    goby review --pr 123            review a pull request
    goby review --diff-file x.diff --dry-run
    goby gate --pr 123              refresh merge eligibility (no model call)
    goby init                       write the GitHub Actions workflow
    goby doctor                     print the resolved configuration
    goby version

``review`` is a thin dispatcher onto ``goby.core.review``, which owns its own
flags (run ``goby review --help`` for the full list).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from goby import __version__

WORKFLOW_PATH = Path(".github/workflows/goby-review.yml")

WORKFLOW_TEMPLATE = """\
# goby review — posts findings as inline review comments on every PR.
#
# Required secret: {key_env} (the model provider's key).
#
# Trust note: this workflow runs a reviewed, commit-pinned action and
# reads PR code through the GitHub API only — it never checks out or executes
# code from the pull request. Do not add a checkout of the PR head here, and
# do not install dependencies declared by the PR.
name: Goby review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  statuses: write

concurrency:
  group: goby-review-${{{{ github.event.pull_request.number }}}}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: Coral-Bricks-AI/goby@{action_ref}
        with:
          provider: {provider}
          model: {model}
        env:
          {key_env}: ${{{{ secrets.{key_env} }}}}
"""


def _cmd_review(argv: list[str]) -> int:
    from goby.core import review

    return review.main(argv)


def _cmd_init(argv: list[str]) -> int:
    from goby.providers import resolve_provider

    ap = argparse.ArgumentParser(prog="goby init")
    ap.add_argument("provider", nargs="?")
    ap.add_argument("--ref", required=True, help="Reviewed full Goby commit SHA to pin")
    args = ap.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", args.ref):
        ap.error("--ref must be a full commit SHA, not an unpublished or mutable tag")
    provider = resolve_provider(args.provider)
    model = provider.default_model or ""
    target = WORKFLOW_PATH
    if target.exists():
        print(f"{target} already exists — leaving it alone.", file=sys.stderr)
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        WORKFLOW_TEMPLATE.format(
            provider=provider.name, model=model, key_env=provider.api_key_env,
            action_ref=args.ref
        ),
        encoding="utf-8",
    )
    print(f"wrote {target}")
    print()
    print("Next:")
    print(f"  1. add a repository secret named {provider.api_key_env}")
    print("  2. commit and push the workflow")
    print("  3. open a PR — findings and Goby Gate arrive on its head commit")
    print("  4. require Goby Gate (not Goby Review) and your CI in branch protection")
    print()
    print("Local preview, posting nothing:")
    print("  goby review --pr <number> --dry-run")
    return 0


def _cmd_doctor(argv: list[str]) -> int:
    from goby.core.review import DEFAULT_KEY_FILE
    from goby.providers import resolve_provider

    provider = resolve_provider(argv[0] if argv else None)
    key_file = Path(os.path.expanduser(DEFAULT_KEY_FILE))
    key_source = "missing"
    for env_name in ("GOBY_API_KEY", provider.api_key_env):
        if os.environ.get(env_name):
            key_source = f"${env_name}"
            break
    else:
        if key_file.exists():
            key_source = str(key_file)

    print(f"goby        {__version__}")
    print(f"provider      {provider.name}")
    print(f"endpoint      {provider.base_url}")
    print(f"model         {provider.default_model or '(none — set --model)'}")
    print(f"api key       {key_source}")
    print(f"github token  {'yes' if os.environ.get('GITHUB_TOKEN') else 'no'}")
    print(f"responses api {'yes' if provider.supports_responses else 'no'}"
          " (--agent needs it)")
    return 0 if key_source != "missing" else 1


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0 if args else 2
    command, rest = args[0], args[1:]
    if command in ("version", "--version", "-V"):
        print(__version__)
        return 0
    if command == "review":
        return _cmd_review(rest)
    if command == "gate":
        from goby.core import gate

        return gate.main(rest)
    if command == "init":
        return _cmd_init(rest)
    if command == "doctor":
        return _cmd_doctor(rest)
    print(f"unknown command {command!r}; try `goby --help`", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
