#!/usr/bin/env python3
"""File a hunt's findings as GitHub issues — the last step of every hunter task.

    python3 post_findings.py --findings /workspace/out/findings.jsonl \
        --repo Coral-Bricks-AI/www --sha <sha> \
        --issues-per-day 3 [--out FILE | --dry-run]

One issue per confirmed finding. Three gates, in order:

1. **Already filed** — the fingerprint (component, file basename, normalised title) is on an
   open *or closed* issue. Closed matters: it stops a defect the team decided is not a
   defect from coming back every week.
2. **`issues_per_day`** — what a human was handed in the last 24 hours, across the repo. A
   `high` finding is exempt, because the cap exists to bound noise, not to bury a real one.
3. **Nothing else.** There is no digest, no weekly bucket, and no judge: the hunter already
   proved the defect with two runs, and `report_finding` refuses a claim without them.

Everything that talks to GitHub is one function (`_http`), so the whole decision path is
testable without a network, and `--out` writes the plan instead of posting.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
LABEL = "goby-cleaners"
MARKER = re.compile(
    r"<!-- goby-cleaners fp=([0-9a-f]{12}) component=(\S+) severity=(\w+) -->")


def issue_label() -> str:
    """The label this run files under, and the one its dedupe reads.

    Both must be the same label, or two producers of the same findings cannot see each
    other's issues and file one defect twice — which is what a transition between two
    runners looks like. `CLEANERS_LABEL` exists for that window and for a repo that already
    uses its own name; the marker comment keeps the default either way.
    """
    return os.environ.get("CLEANERS_LABEL") or LABEL


def _norm(text) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", str(text or "").lower()).split())


def fingerprint(component: str, finding: dict) -> str:
    """Content-shaped, so the same defect after a directory move collides and is not re-filed.

    The component is the directory, so a rename of the *file* keeps its history only by
    basename; a rename of the component directory re-files, which the daily cap bounds.
    """
    file_name = Path(str(finding.get("file") or "")).name
    raw = "|".join([component, file_name, _norm(finding.get("title"))])
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


def marker(component: str, finding: dict, fp: str, severity: str) -> str:
    return (f"<!-- goby-cleaners fp={fp} component={component} "
            f"severity={severity} -->")


def parse_marker(body: str) -> re.Match | None:
    return MARKER.search(body or "")


def _parse_ts(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def decide(findings: list[dict], existing: list[dict], *,
           issues_per_day: int, now: datetime | None = None) -> tuple[list[dict], list[dict]]:
    """Split findings into (file, skip). `existing` is the repo's `goby-cleaners` issues.

    Order matters: a duplicate is dropped before it can consume budget, so a re-hunt of the
    same component does not starve a real finding by spending the day's allowance on things
    a human already has.
    """
    now = now or datetime.now(timezone.utc)
    day_floor = now - timedelta(days=1)

    seen_existing: set[str] = set()
    day_count = 0
    for issue in existing:
        markers = list(MARKER.finditer(issue.get("body") or ""))
        if not markers:
            continue
        created = _parse_ts(issue.get("created_at") or "")
        for m in markers:
            fp = m.group(1)
            if fp in seen_existing:
                continue
            seen_existing.add(fp)
            # The daily cap is about what a human was handed today. A high finding is
            # exempt: the cap bounds noise, it must not bury the one that matters.
            if created and created >= day_floor and m.group(3) != "high":
                day_count += 1

    filed, skipped = [], []
    # Two defects in one file can share a title, and then share a fingerprint: the key is
    # component + file + title precisely so a re-worded report of the same defect collapses.
    # Inside one run they are two claims by the same agent, so the distinction that survives
    # is the reproducer — the same one twice is a duplicate, a different one is a second
    # defect that would otherwise be dropped silently.
    # Every repro filed for a fingerprint, not the first one: a run that emits r1, r2, r2 under
    # one fingerprint remembered only r1, so the third compared itself against r1, was not a
    # duplicate, and filed r2 a second time. Same defect, two issues, in one run.
    batch: dict[str, set[str]] = {}
    for finding in findings:
        component = str(finding.get("component") or "")
        severity = str(finding.get("severity") or "medium")
        fp = fingerprint(component, finding)
        repro = str(finding.get("repro_command") or "").strip()
        if fp in seen_existing:
            skipped.append({"fingerprint": fp, "reason": "already filed",
                            "title": finding.get("title")})
            continue
        if fp in batch and repro in batch[fp]:
            skipped.append({"fingerprint": fp, "reason": "duplicate in this run",
                            "title": finding.get("title")})
            continue
        # Recorded only once the finding is actually filed. A finding held back by the cap is
        # not something a later one can be a duplicate *of*: `high` findings are exempt from
        # the cap, so a capped medium followed by its high-severity match must still file,
        # and recording the skipped one here is what would suppress it.
        if severity != "high" and day_count >= issues_per_day:
            skipped.append({"fingerprint": fp, "reason": "daily budget spent",
                            "title": finding.get("title")})
            continue
        batch.setdefault(fp, set()).add(repro)
        if severity != "high":
            day_count += 1
        filed.append({"fingerprint": fp, "finding": finding, "severity": severity})
    return filed, skipped


def render_issue(component: str, item: dict, sha: str) -> tuple[str, str]:
    f = item["finding"]
    fp, severity = item["fingerprint"], item["severity"]
    short = Path(component).name or component
    title = f"[{issue_label()}] {short}: {f.get('title', 'defect')}"
    body = "\n".join([
        marker(component, f, fp, severity),
        "",
        f"**Component:** `{component}` · **Severity:** {severity} · "
        f"**Commit:** `{sha[:10]}` · **Found by:** goby-cleaners",
        "",
        f"**Invariant violated:** {f.get('invariant', '(none given)')}",
        "",
        f"**Where:** `{f.get('file')}:{f.get('line')}`",
        "",
        f"**Trigger:** {f.get('trigger', '(none given)')}",
        "",
        f"**Observed:** {f.get('observed', '(none given)')}",
        "",
        f"**Expected:** {f.get('expected', '(none given)')}",
        "",
        "**Reproduced by the hunter with:**",
        "",
        "```",
        str(f.get("repro_command") or "").strip(),
        "```",
        "",
        "**Output:**",
        "",
        "```",
        str(f.get("repro_output") or "").strip()[:4000],
        "```",
        "",
        "**And the defect goes away when the blamed line is changed:**",
        "",
        "```",
        str(f.get("flip_command") or "").strip(),
        "```",
        "",
        "**Output after the change:**",
        "",
        "```",
        str(f.get("flip_output") or "").strip()[:2000],
        "```",
        "",
        f"_A hunter found and reproduced this. If it is **not** a defect, close it and add a "
        f"line to `{component}/HUNT.md` under `Known non-findings` — that file is the "
        f"hunter's brief, and a known non-finding stops being reported._",
        "",
    ])
    return title, body


# --- GitHub ------------------------------------------------------------------------


def _http(method: str, path: str, token: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        (path if path.startswith("http") else API + path),
        data=data, method=method,
        headers={"accept": "application/vnd.github+json", "authorization": f"Bearer {token}",
                 "x-github-api-version": "2022-11-28", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, str(e)


# Dedupe has to see every issue carrying the label, in *any* state: a closed "not a bug" is
# the answer that must not be asked again, and GitHub lists newest first, so a truncated read
# loses precisely the oldest verdicts. The bound is therefore on **pages walked**, not on
# issues returned: a page count has no boundary to get wrong, where an issue count creates a
# cliff — with a 2000-issue bound, 2099 issues read cleanly and 2100 refused, although both
# lists are complete (#1298, and #1296 before it). 100 pages is 10 000 issues, about nine
# years at `issues_per_day` 3.
MAX_LABELLED_PAGES = 100


def list_labelled(repo: str, token: str, label: str | None = None,
                  max_pages: int = MAX_LABELLED_PAGES) -> list[dict] | None:
    """Every issue carrying the label, newest first, in any state.

    None when that cannot be known — a failed read, or a list longer than `max_pages` is
    willing to walk. An empty list and a failed read mean opposite things ("nothing filed
    yet" versus "do not know what is filed"), and treating them alike re-files every open
    finding; the same is true of a truncated read, which is why it fails rather than
    returns a prefix. The caller decides what to do with None; this function refuses to
    guess.
    """
    label = label or issue_label()
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        st, body = _http("GET", f"/repos/{repo}/issues?labels={label}&state=all"
                                f"&per_page=100&page={page}", token)
        if st != 200 or not isinstance(body, list):
            print(f"error: list issues ({label}) -> HTTP {st}: {str(body)[:160]}",
                  file=sys.stderr)
            return None
        if not body:
            return out
        out.extend(body)
        if len(body) < 100:
            return out
    # Walked the bound with every page full, so one probe decides between "the history ends
    # exactly here" and "it is longer than we will read". Without it the bound itself refuses
    # a complete read: 10 000 issues fill 100 pages and page 101 is the one that proves it.
    st, body = _http("GET", f"/repos/{repo}/issues?labels={label}&state=all"
                            f"&per_page=100&page={max_pages + 1}", token)
    if st == 200 and isinstance(body, list) and not body:
        return out
    print(f"error: more than {max_pages} pages of issues carry the {label} label; the dedupe "
          f"read is incomplete, so nothing is filed. Raise MAX_LABELLED_PAGES or prune the "
          f"closed ones.", file=sys.stderr)
    return None


def ensure_label(repo: str, token: str, name: str | None = None) -> None:
    name = name or issue_label()
    st, _ = _http("POST", f"/repos/{repo}/labels", token,
                  {"name": name, "color": "0e8a16",
                   "description": "filed by goby-cleaners"})
    if st not in (201, 422):  # 422 = already exists
        print(f"warning: label {name} -> HTTP {st}", file=sys.stderr)


def full_name(repo: str) -> str:
    return repo if "/" in repo else f"Coral-Bricks-AI/{repo}"


def file_findings(repo: str, token: str, sha: str, filed: list[dict]) -> tuple[list[str],
                                                                              list[str]]:
    """(urls, failures). A failure has to reach the caller: a task that exits 0 while a
    reproduced finding was rejected by GitHub is a finding lost with nobody told."""
    urls: list[str] = []
    failures: list[str] = []
    if not filed:
        return urls, failures
    ensure_label(repo, token)
    for item in filed:
        title, body = render_issue(str(item["finding"].get("component") or ""), item, sha)
        st, resp = _http("POST", f"/repos/{repo}/issues", token,
                         {"title": title, "body": body, "labels": [issue_label()]})
        if st == 201 and isinstance(resp, dict):
            urls.append(resp["html_url"])
            continue
        failures.append(f"create issue HTTP {st}: {str(resp)[:160]}")
        print(f"error: {failures[-1]}", file=sys.stderr)
    return urls, failures


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--findings", type=Path, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--issues-per-day", type=int, default=3)
    ap.add_argument("--out", type=Path, default=None, help="write the plan instead of posting")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    findings = []
    if args.findings.is_file():
        for line in args.findings.read_text().splitlines():
            if line.strip():
                findings.append(json.loads(line))
    # The component decides the fingerprint and the issue title. A finding without one means
    # the extension was not told which component it is hunting, which would file a defect
    # under the wrong owner — fail instead of guessing.
    missing = [f.get("title") for f in findings if not f.get("component")]
    if missing:
        print(f"error: findings without a component: {missing[:3]}", file=sys.stderr)
        return 2
    if not findings:
        print(json.dumps({"findings": 0, "filed": [], "skipped": []}))
        return 0

    repo = full_name(args.repo)
    token = os.environ.get("GITHUB_TOKEN", "")
    response_only = args.dry_run or args.out is not None
    if not token and not response_only:
        print("error: GITHUB_TOKEN is required unless --dry-run/--out is used", file=sys.stderr)
        return 2

    if response_only:
        existing = []
    else:
        listed = list_labelled(repo, token)
        if listed is None:
            # Croak rather than file: without the history, dedupe and budget are both blind.
            print("error: cannot read the existing findings; nothing filed", file=sys.stderr)
            return 1
        existing = listed

    filed, skipped = decide(findings, existing, issues_per_day=args.issues_per_day)

    plan = {
        "sha": args.sha,
        "findings": len(findings),
        "filed": [{"fingerprint": i["fingerprint"], "component": i["finding"].get("component"),
                   "title": i["finding"].get("title"), "severity": i["severity"]}
                  for i in filed],
        "skipped": skipped,
        "urls": [],
        "failures": [],
    }
    if response_only:
        plan["dry_run"] = True
        if args.out:
            args.out.write_text(json.dumps(plan, indent=2) + "\n")
    else:
        plan["urls"], plan["failures"] = file_findings(repo, token, args.sha, filed)
    print(json.dumps(plan, indent=2))
    return 1 if plan["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
