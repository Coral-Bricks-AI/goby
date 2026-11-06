#!/usr/bin/env python3
"""File a sweep's proposals as GitHub issues — the last step of every tide task.

    python3 post_issues.py --proposals out/proposals.jsonl --candidates out/candidates.jsonl \
        --repo <owner>/<repo> --sha <sha> --issues-per-day 5 \
        [--close-gone] [--out FILE]

One issue per over-threshold smell the agent wrote a plan for. Four decisions, in order:

1. **Already open** — the fingerprint (`check|path`) is on an *open* `goby-tide` issue. Open
   only, unlike the cleaner: a code smell can come back. A file that was split and then grew
   past the threshold again is a new issue, and the closed one is the record that it was fixed
   once. The fingerprint contains no model wording, so a re-titled report of the same 1,432-line
   file is still the same fingerprint.
2. **Gone** — with `--close-gone`, an open issue whose smell this sweep no longer measures is
   closed with the measurement that replaced it. That flag is passed only by a sweep that
   measured the whole repository: a partial or failed detection must not close anything.
3. **`issues_per_day`** — what a human was handed by the tide in the last 24 hours. There is no
   severity exemption, because a smell has no severity: the detector's threshold is the filter.
4. **Nothing else.** No digest, no weekly bucket, no judge. The sweep measured a number, and the
   agent proved its plan keeps the suite green.

Filing, labelling and reading the history live in `common/issues.py`, shared with
`goby-cleaners`. This module reads its own label and nothing else.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# The shared filing machinery lives in `common/`. The repository (`tide/` beside `common/`) and
# every image (`/opt/tide` beside `/opt/common`) put the two in the same shape; `GOBY_COMMON_DIR`
# exists for a layout that is neither.
def _common_dir() -> Path:
    here = Path(__file__).resolve().parent
    candidates = [here.parent / "common", Path("/opt/common")]
    override = os.environ.get("GOBY_COMMON_DIR")
    if override:
        candidates.insert(0, Path(override))
    for candidate in candidates:
        if (candidate / "issues.py").is_file():
            return candidate
    raise RuntimeError(f"no common/issues.py; looked in {', '.join(map(str, candidates))}")


sys.path.insert(0, str(_common_dir()))
import issues as common  # noqa: E402 — after the path bootstrap above

# Tests stub this module attribute (and so does the dry run), so the shared calls take it as an
# argument instead of reaching for their own copy.
_http = common._http

LABEL = "goby-tide"
DEFAULT_PRODUCER = "goby-tide"
MARKER = common.Marker(
    token=DEFAULT_PRODUCER,
    # `path` is last and lazy: a path may contain a space, and a greedy `.+` swallowed the
    # separator's own space, so the marker written by one run read back with a trailing space and
    # stopped matching the next run's key. `check` is a fixed word from the detector. A marker the
    # grammar cannot read is a filing the next sweep cannot see, and it files the same smell again.
    pattern=(r"<!--\s+[A-Za-z0-9._-]+\s+fp=(?P<fp>[0-9a-f]{12})"
             r"\s+check=(?P<check>[a-z_]+)\s+path=(?P<path>.+?)\s*-->"),
    template="<!-- {token} fp={fp} check={check} path={path} -->",
)


def issue_label() -> str:
    """The label this sweep files under, and the one its dedupe reads.

    Both must be the same label, or a repository that renames its label loses the ability to see
    its own already-filed issues. `TIDE_LABEL` exists for that; the marker token does not move.
    """
    return os.environ.get("TIDE_LABEL") or LABEL


def product() -> common.Product:
    return common.Product(
        label=common.Label(LABEL, "0e8a16", "filed by goby-tide"),
        marker=MARKER,
    ).renamed(issue_label())


def _parse_ts(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def decide(proposals: list[dict], open_issues: list[dict], *,
           issues_per_day: int, now: datetime | None = None) -> tuple[list[dict], list[dict]]:
    """Split proposals into (file, skip). `open_issues` is the repository's open tide issues.

    Closed issues are deliberately not passed in: a closed smell is one a human dealt with, and
    code grows back.
    """
    now = now or datetime.now(timezone.utc)
    day_floor = now - timedelta(days=1)

    open_fp = common.marker_index(open_issues, MARKER)
    day_count = 0
    for issue in open_fp.values():
        created = _parse_ts(issue.get("created_at") or "")
        if created and created >= day_floor:
            day_count += 1

    filed, skipped = [], []
    batch: set[str] = set()
    for proposal in proposals:
        fp = proposal["fingerprint"]
        title = proposal.get("summary") or proposal.get("path")
        if fp in open_fp:
            skipped.append({"fingerprint": fp, "reason": "already open", "title": title})
            continue
        if fp in batch:
            skipped.append({"fingerprint": fp, "reason": "duplicate in this run", "title": title})
            continue
        if day_count >= issues_per_day:
            skipped.append({"fingerprint": fp, "reason": "daily budget spent", "title": title})
            continue
        batch.add(fp)
        day_count += 1
        filed.append(proposal)
    return filed, skipped


def gone(candidates: list[dict], open_issues: list[dict]) -> list[dict]:
    """Open issues whose smell this sweep no longer measures.

    `candidates` is every measurement of the repository, not the picked subset: a smell that is
    merely over this sweep's model-call budget is still there, and closing it would be a lie.
    """
    current = {c["fingerprint"] for c in candidates}
    return [issue for fp, issue in common.marker_index(open_issues, MARKER).items()
            if fp not in current]


def _clip(text: str, limit: int, what: str, *, follows_from_plan: bool = False) -> str:
    """The text, cut at a line boundary, and a note saying so when it has to be cut.

    A silently truncated block is the failure this whole file argues against: the issue looks
    complete, and the reader cannot tell that the end of the diff — or of the run that is the
    evidence for it — is missing. The cap itself stays: an issue is a plan, not a patch, and a
    thousand-line body is one nobody reads. What changes is that a cut is visible.
    """
    body = str(text or "").strip()
    if len(body) <= limit:
        return body
    cut = body[:limit]
    head = cut.rsplit("\n", 1)[0] if "\n" in cut else cut
    if "\n" in head:
        shown, total, unit = head.count("\n") + 1, body.count("\n") + 1, "lines"
    else:
        # Nothing survived the cut but part of one line — a one-paragraph summary, a one-line
        # command, a minified diff. Counting lines there says "showing 1 of 1 lines", which claims
        # nothing was omitted while characters were dropped, so characters are what get counted.
        shown, total, unit = len(head), len(body), "characters"
    note = f"…{what} truncated: showing {shown:,} of {total:,} {unit}."
    if follows_from_plan:
        note += " The full change is reproducible by following the plan above."
    return f"{head}\n\n{note}"


def render_issue(proposal: dict, sha: str) -> tuple[str, str]:
    """The title is the measurement, the body is the plan.

    A title a model wrote would drift between sweeps; the measurement does not, so the same smell
    reads the same way in a search next month.
    """
    fp, check = proposal["fingerprint"], proposal["check"]
    path, metric = proposal["path"], proposal["metric"]
    threshold, unit = proposal["threshold"], proposal["unit"]
    title = f"[{issue_label()}] {path}: {metric:,} {unit} (limit {threshold:,})"
    body = [
        MARKER.render(token=MARKER.token, fp=fp, check=check, path=path),
        "",
        f"**Measured:** {metric:,} {unit} — the limit is {threshold:,} · "
        f"**Check:** `{check}` · **Commit:** `{sha[:10]}` · **Found by:** goby-tide",
        "",
        "**Why this is worth fixing**",
        "",
        _clip(proposal.get("summary"), 4000, "summary"),
        "",
        "**How to take it apart**",
        "",
        _clip(proposal.get("plan"), 8000, "plan"),
        "",
    ]
    if proposal.get("applied"):
        body += [
            "**Verified in a container** — the suite was run before the change and after it.",
            "",
            f"```\n{_clip(proposal.get('tests_command'), 500, 'test command')}\n```",
            "",
            "Before:",
            "",
            f"```\n{_clip(proposal.get('tests_output_before'), 3000, 'before output')}\n```",
            "",
            "After:",
            "",
            f"```\n{_clip(proposal.get('tests_output_after'), 3000, 'after output')}\n```",
            "",
        ]
    else:
        body += [
            "**Not verified in a container** — the plan below has not been run.",
            "",
            _clip(proposal.get("unverified_reason"), 2000, "reason") or "(no reason given)",
            "",
        ]
    if proposal.get("diff"):
        body += [
            "**The change the sweep applied** — this is what the after-run tested:",
            "",
            # The cap stays at 12k characters: an issue is a plan, not a patch. A cut is now
            # visible and says where the rest comes from.
            f"```diff\n{_clip(proposal.get('diff'), 12000, 'diff', follows_from_plan=True)}\n```",
            "",
        ]
    elif proposal.get("applied"):
        # `applied: true` and an empty sandbox is a contradiction the harness can see, and the
        # issue must not present the two test runs as evidence for a change nobody can read.
        body += [
            "**No change was left in the sandbox**, so the after-run above cannot be compared "
            "against a diff. Treat the plan as measured-and-tested, not as reviewed.",
            "",
        ]
    body += [
        "**What must not change**",
        "",
        _clip(proposal.get("risk"), 4000, "risk"),
        "",
        "---",
        "",
        "A refactor, not a fix: behaviour and the tests are expected to be identical afterwards.",
        "",
        "**If this is not worth doing, closing it does not stop it coming back.** Every sweep "
        "re-measures the whole tree, so the same file is filed again on the next run. Close it "
        "*and* add this to `.goby/tide.json`, as the whole document if that file does not exist "
        "yet and as an entry in its `known` array if it does:",
        "",
        "```json",
        f'{{ "known": [ {{ "check": "{check}", "path": "{path}", '
        f'"reason": "why this is fine as it is" }} ] }}',
        "```",
        "",
        "`reason` is required — it is what the next reader of that file finds beside the path. A "
        "`known` entry is measured and then skipped, so it stops being filed; when it stops "
        "firing, because the file was finally split, the sweep logs that the entry can be "
        "deleted. A key the sweep does not recognise is an error rather than a silence, so an "
        "entry added in the wrong shape fails the run instead of doing nothing.",
        "",
    ]
    return title, "\n".join(body)


def file_proposals(repo: str, token: str, sha: str, filed: list[dict]
                   ) -> tuple[list[str], list[str]]:
    """(urls, failures). Each issue carries `goby-tide` and the general `goby` label."""
    return common.file_issues(repo, token, product(), filed,
                              lambda proposal: render_issue(proposal, sha), http=_http)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proposals", type=Path, required=True)
    ap.add_argument("--candidates", type=Path, required=True,
                    help="every measurement this sweep made; used to close what is gone")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--issues-per-day", type=int, required=True)
    ap.add_argument("--close-gone", action="store_true",
                    help="close open issues whose smell this sweep no longer measures")
    ap.add_argument("--out", type=Path, default=None, help="write the plan instead of posting")
    args = ap.parse_args(argv)

    proposals = [json.loads(line) for line in args.proposals.read_text().splitlines()
                 if line.strip()] if args.proposals.is_file() else []
    candidates = [json.loads(line) for line in args.candidates.read_text().splitlines()
                  if line.strip()] if args.candidates.is_file() else []

    repo = common.full_name(args.repo)
    token = os.environ.get("GITHUB_TOKEN", "")
    plan_only = args.out is not None
    if not token and not plan_only:
        print("error: GITHUB_TOKEN is required unless --out is used", file=sys.stderr)
        return 2

    if plan_only:
        opened: list[dict] = []
    else:
        listed = common.list_labelled(repo, token, issue_label(), state="open", http=_http)
        if listed is None:
            # Croak rather than file: without the open issues, dedupe and the cap are both blind.
            print("error: cannot read the open tide issues; nothing filed", file=sys.stderr)
            return 1
        opened = listed

    to_file, skipped = decide(proposals, opened, issues_per_day=args.issues_per_day)
    to_close = gone(candidates, opened) if args.close_gone else []

    plan = {
        "sha": args.sha,
        "proposals": len(proposals),
        "filed": [{"fingerprint": p["fingerprint"], "path": p["path"], "check": p["check"]}
                  for p in to_file],
        "skipped": skipped,
        "closed": [],
        "urls": [],
        "failures": [],
    }
    if plan_only:
        plan["closed"] = [{"number": i.get("number"), "title": i.get("title")} for i in to_close]
        args.out.write_text(json.dumps(plan, indent=2) + "\n")
        print(json.dumps(plan, indent=2))
        return 0

    plan["urls"], plan["failures"] = file_proposals(repo, token, args.sha, to_file)
    for issue in to_close:
        number = issue.get("number")
        if number is None:
            continue
        parsed = MARKER.parse(issue.get("body") or "")
        measured = parsed.group("path") if parsed else issue.get("title")
        comment = (f"`{measured}` is no longer over its threshold at `{args.sha[:10]}`, so this "
                   f"smell is gone (split, shrunk, or excluded from the sweep). Closing.")
        if common.close_issue(repo, token, number, comment, http=_http):
            plan["closed"].append(number)
        else:
            plan["failures"].append(f"close #{number} failed")
    print(json.dumps(plan, indent=2))
    return 1 if plan["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
