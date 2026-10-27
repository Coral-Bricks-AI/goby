"""Re-evaluate Goby's review gate without a model call or a merge."""
from __future__ import annotations

import argparse
import json
import os
from dataclasses import asdict
from pathlib import Path

from goby.core.verdict import GateResult, ReviewReceipt, evaluate_gate, parse_receipt
from goby.identity import BOT_LOGINS, STATUS_CONTEXT, SUMMARY_PREFIX
from goby.platforms import github as fetch
from goby.platforms.publish import post_gate_status


class HeadChanged(RuntimeError):
    """The caller's expected commit is no longer the PR head."""


def load_receipt(token: str, repo: str, pr: int, head: str) -> ReviewReceipt | None:
    """Read the latest own review on this exact head, or refuse partial data.

    Do not fall back to an older green receipt when the latest review is
    malformed or incomplete. GitHub login + commit_id + header authenticate
    the envelope; the model cannot grant eligibility by writing JSON.
    """
    latest = None
    for page in range(1, 21):
        rows = json.loads(fetch.gh_get(
            f"/repos/{repo}/pulls/{pr}/reviews?per_page=100&page={page}", token))
        if not isinstance(rows, list):
            raise RuntimeError("Invalid GitHub review response")
        for row in rows:
            if not isinstance(row, dict):
                raise RuntimeError("Invalid GitHub review record")
            if ((row.get("user") or {}).get("login") in BOT_LOGINS
                    and row.get("commit_id") == head
                    and row.get("state") in ("COMMENTED", "APPROVED", "CHANGES_REQUESTED")
                    and (row.get("body") or "").startswith(SUMMARY_PREFIX)):
                if latest is None or row["id"] > latest["id"]:
                    latest = row
        if len(rows) < 100:
            return parse_receipt(latest["body"], head) if latest else None
    raise RuntimeError("Review pagination cap reached; refusing partial evidence")


def assert_head(token: str, repo: str, pr: int, expected: str) -> None:
    if fetch.fetch_pr_meta(repo, pr, token)["head_sha"] != expected:
        raise HeadChanged("PR head changed; rerun for the current commit")


def refresh_gate(token: str, repo: str, pr: int, *, expected_head: str | None = None,
                 dry_run: bool = False) -> GateResult:
    head = expected_head or fetch.fetch_pr_meta(repo, pr, token)["head_sha"]
    assert_head(token, repo, pr, head)
    if not dry_run:
        post_gate_status(token, repo, head, "pending", "Checking review evidence")
    try:
        receipt = load_receipt(token, repo, pr, head)
        opened, resolved, complete = fetch.fetch_thread_state(token, repo, pr)
        execution_succeeded = fetch.latest_status_state(
            token, repo, head, STATUS_CONTEXT) == "success"
        result = evaluate_gate(receipt, head, opened, resolved, complete,
                               execution_succeeded=execution_succeeded)
    except (fetch.GitHubError, RuntimeError, OSError, ValueError, KeyError, TypeError) as exc:
        result = GateResult(head, "error", f"Cannot establish review eligibility: {exc}")
    # The remote head may move while paginating. Never green a different head.
    # A merger must still use an atomic --match-head-commit for the final race.
    assert_head(token, repo, pr, head)
    if not dry_run:
        post_gate_status(token, repo, head, result.state, result.description)
    return result


def main(argv: list[str] | None = None) -> int:
    from goby.core.review import repo_from_remote

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    ap.add_argument("--token", default=os.environ.get("GITHUB_TOKEN"))
    ap.add_argument("--expected-head", help="Refuse a stale workflow's commit")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--output-file", help="Write the gate result as JSON (no model output)")
    args = ap.parse_args(argv)
    args.repo = args.repo or repo_from_remote()
    if not args.repo or not args.token:
        ap.error("--repo and --token (or their environment variables) are required")
    try:
        result = refresh_gate(args.token, args.repo, args.pr,
                              expected_head=args.expected_head, dry_run=args.dry_run)
    except (HeadChanged, fetch.GitHubError, OSError, RuntimeError) as exc:
        print(json.dumps({"state": "error", "description": str(exc)}))
        return 1
    payload = json.dumps(asdict(result))
    print(payload)
    if args.output_file:
        Path(args.output_file).write_text(payload + "\n", encoding="utf-8")
    return 0 if result.allowed else (1 if result.state == "error" else 2)
