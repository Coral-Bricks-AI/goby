"""Fail-closed review eligibility, separate from review execution status.

A receipt is produced by code, never by the model. Full commit IDs and the
expected inline finding IDs prevent an old/partial/missing review from being
mistaken for an all-clear. The receipt is evidence, not permission to merge:
CI and an atomic head comparison remain the merger's responsibility.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

_PREFIX = "<!-- goby-gate "
_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


@dataclass(frozen=True)
class ReviewReceipt:
    head_sha: str
    complete: bool
    agent: bool
    unthreaded: int
    finding_ids: tuple[str, ...]
    schema: int = 1

    def marker(self) -> str:
        return _PREFIX + json.dumps(asdict(self), separators=(",", ":")) + " -->"


def parse_receipt(body: str, commit_id: str) -> ReviewReceipt | None:
    # Multiple markers (including one smuggled through finding prose) are
    # ambiguous. Do not select a conveniently green one.
    lines = [line for line in body.splitlines() if line.startswith(_PREFIX)]
    if len(lines) != 1 or not lines[0].endswith(" -->"):
        return None
    try:
        data = json.loads(lines[0][len(_PREFIX):-4])
        if not isinstance(data, dict) or set(data) != {
            "schema", "head_sha", "complete", "agent", "unthreaded", "finding_ids"
        }:
            return None
        if type(data["schema"]) is not int or data["schema"] != 1:
            return None
        if not isinstance(data["head_sha"], str) or not _SHA.fullmatch(data["head_sha"]):
            return None
        if data["head_sha"] != commit_id:
            return None
        if type(data["complete"]) is not bool or type(data["agent"]) is not bool:
            return None
        if type(data["unthreaded"]) is not int or data["unthreaded"] < 0:
            return None
        ids = data["finding_ids"]
        if not isinstance(ids, list) or any(
            not isinstance(fid, str) or not re.fullmatch(r"[0-9a-f]+", fid)
            for fid in ids
        ) or len(ids) != len(set(ids)):
            return None
        return ReviewReceipt(**{**data, "finding_ids": tuple(ids)})
    except (ValueError, TypeError):
        return None


def gate_allowed(*, receipt_valid: bool, same_head: bool, complete: bool,
                 agent: bool, no_unthreaded: bool, threads_complete: bool,
                 findings_accounted: bool, no_open_threads: bool,
                 execution_succeeded: bool) -> bool:
    """All nine facts must be positively established; unknown is not true.

    proofs/verify.ts proves this policy and compares every Boolean input with
    this production function. Keep it a decision, not a remembered green flag.
    """
    return all(value is True for value in (
        receipt_valid, same_head, complete, agent, no_unthreaded,
        threads_complete, findings_accounted, no_open_threads, execution_succeeded,
    ))


@dataclass(frozen=True)
class GateResult:
    head_sha: str
    state: str
    description: str

    @property
    def allowed(self) -> bool:
        return self.state == "success"


def evaluate_gate(receipt: ReviewReceipt | None, head_sha: str,
                  open_threads: list[dict], resolved_threads: list[dict],
                  threads_complete: bool, *, execution_succeeded: bool = False) -> GateResult:
    # Thread identities are scoped to the receipt's full commit. A finding
    # with the same path/title on an old head is not evidence that this round
    # was published. Legacy thread markers carry the first ten SHA digits.
    observed = {
        t.get("fid") for t in open_threads + resolved_threads
        if t.get("sha") == head_sha[:10]
    }
    facts = {
        "receipt_valid": receipt is not None,
        "same_head": receipt is not None and receipt.head_sha == head_sha,
        "complete": receipt is not None and receipt.complete,
        "agent": receipt is not None and receipt.agent,
        "no_unthreaded": receipt is not None and receipt.unthreaded == 0,
        "threads_complete": threads_complete,
        "findings_accounted": receipt is not None and set(receipt.finding_ids) <= observed,
        "no_open_threads": not open_threads,
        "execution_succeeded": execution_succeeded,
    }
    reasons = {
        "receipt_valid": "No valid review receipt for this head",
        "same_head": "Review belongs to a different commit",
        "complete": "Review incomplete (budget exhausted or answer truncated)",
        "agent": "An agentic review is required",
        "no_unthreaded": "Unthreaded or capped findings require a new review after a fix",
        "threads_complete": "Thread state is incomplete; refusing to guess",
        "findings_accounted": "Published finding threads are missing",
        "no_open_threads": f"{len(open_threads)} unresolved Goby finding(s)",
        "execution_succeeded": "Latest review execution did not succeed",
    }
    if gate_allowed(**facts):
        return GateResult(head_sha, "success", "Complete review; no unresolved Goby findings")
    return GateResult(head_sha, "failure", next(
        reasons[key] for key, value in facts.items() if value is not True
    ))
