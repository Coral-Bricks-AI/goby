#!/usr/bin/env python3
"""File a scan's findings as GitHub issues — the last step of every cleaner task.

    python3 post_findings.py --findings /workspace/out/findings.jsonl \
        --repo <owner>/<repo> --sha <sha> \
        --issues-per-day 25 [--out FILE | --dry-run]

One issue per confirmed finding. Three gates, in order:

1. **Already filed** — the fingerprint (component, file basename, normalised title) is on an
   open *or closed* issue. Closed matters: it stops a defect the team decided is not a
   defect from coming back every week.
2. **`issues_per_day`** — what a human was handed in the last 24 hours, across the repo. A
   `high` finding is exempt, because the cap exists to bound noise, not to bury a real one.
3. **Nothing else.** There is no digest, no weekly bucket, and no judge: the cleaner already
   proved the defect with two runs, and `report_finding` refuses a claim without them.

The decisions in this file are this product's own. Filing, labelling and reading the history
are not: those live in `common/issues.py`, shared with `goby-tide`, so a fix to the dedupe read
or the label convention reaches both products. This module reads its *own* label and nothing
else — a cleaner finds defects in what a push touched, a tide finds smells on a schedule, so
their issues never overlap and neither product's page budget depends on the other's history.

Everything that talks to GitHub is one function (`_http`), re-exported from `common` so the
whole decision path is testable without a network, and `--out` writes the plan instead of
posting.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


# The shared filing machinery lives in `common/`. The repository (`cleaners/` beside `common/`)
# and every image (`/opt/cleaners` beside `/opt/common`) put the two in the same shape, so this
# resolves without knowing which one it is in; `GOBY_COMMON_DIR` exists for a layout that is
# neither.
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

# Tests stub this module attribute, so it is kept here and passed into every shared call rather
# than letting `common` use its own copy.
_http = common._http

LABEL = "goby-cleaners"
# The marker identifies a filing by its fields, not by the name that wrote it: a repo can be
# scanned by two producers at once, and a rename must not lose the dedupe history. Parsing only
# our own prefix made every legacy issue invisible to `decide` — it saw no fingerprints and no
# daily budget, and filed the same defect again.
# The component is a directory path, and a directory may contain a space. `\S+` stopped at the
# first one, so the marker a run had just written was unparsable and the next run re-filed the
# same defect on every scan. The component therefore runs to the *last* ` severity=` on the line:
# greedy, because a directory name may itself end in ` severity=high -->`, and reading the first
# delimiter would file a medium finding as exempt-from-the-cap high.
# The producer token is fixed, not the active label: a label is a repository's own convention and
# may contain characters the marker grammar rejects (`cleaners/goby` did exactly that), which made
# the issue a run had just filed invisible to its own next dedupe. The writer stays beside the
# grammar it was written for.
DEFAULT_PRODUCER = "goby-cleaners"
MARKER = common.Marker(
    token=DEFAULT_PRODUCER,
    pattern=(r"<!--\s+[A-Za-z0-9._-]+\s+fp=(?P<fp>[0-9a-f]{12})"
             r"\s+component=(?P<component>.+)\s+severity=(?P<severity>\w+)"
             # `v=` is trailing and optional: a run that cannot name its version writes a marker
             # identical to the ones already filed, so every issue in every repository keeps
             # matching its own dedupe after this change.
             r"(?:\s+v=(?P<version>[0-9][0-9A-Za-z.+-]*))?\s*-->"),
    # The producer token is fixed, not the active label: a label is a repository's own
    # convention and may contain characters the marker grammar rejects (`cleaners/goby` did
    # exactly that), which made the issue a run had just filed invisible to its own next
    # dedupe. The writer stays beside the grammar it was written for.
    template=("<!-- {token} fp={fp} component={component} severity={severity}{version} -->"),
)


def product() -> common.Product:
    """This run's identity: the label it files under, and the marker it reads back."""
    return common.Product(
        label=common.Label(LABEL, "0e8a16", "filed by goby-cleaners"),
        marker=MARKER,
    ).renamed(issue_label())


def issue_label() -> str:
    """The label this run files under, and the one its dedupe reads.

    Both must be the same label, or two producers of the same findings cannot see each
    other's issues and file one defect twice — which is what a transition between two
    runners looks like. `CLEANERS_LABEL` exists for that window and for a repo that already
    uses its own name; the marker comment keeps the default either way.
    """
    return os.environ.get("CLEANERS_LABEL") or LABEL


def _norm(text) -> str:
    r"""Case, punctuation and spacing beaten out of a title.

    ASCII letters and digits survive; everything else becomes a space. A title in a non-Latin
    script therefore normalises to "" (or to the ASCII words in it), so two such titles in one
    file share a fingerprint — accepted: our findings are titled in English, and keeping the
    script cost a fingerprint change for every accented title we have already filed. Recorded
    under "Known non-findings" in INVARIANTS.md.
    """
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
    return MARKER.render(token=MARKER.token, fp=fp, component=component, severity=severity)


def parse_marker(body: str) -> re.Match | None:
    """The filing's own marker: the first thing in the body, not anywhere in it.

    A marker quoted *inside* a body is evidence, not a filing — a scan of this repository has
    markers in its repro output. Searching the whole body let one quoted marker suppress the real
    finding it named, and spend the daily budget that finding needed.
    """
    return MARKER.parse(body)


def _parse_ts(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def decide(findings: list[dict], existing: list[dict], *,
           issues_per_day: int, now: datetime | None = None) -> tuple[list[dict], list[dict]]:
    """Split findings into (file, skip). `existing` is the repo's `goby-cleaners` issues.

    Order matters: a duplicate is dropped before it can consume budget, so a re-scan of the
    same component does not starve a real finding by spending the day's allowance on things
    a human already has.
    """
    now = now or datetime.now(timezone.utc)
    day_floor = now - timedelta(days=1)

    seen_existing: set[str] = set()
    day_count = 0
    for issue in existing:
        # One filing, one marker: the leading one. Anything quoted later in the body is part of
        # the evidence, not a second filing.
        marker = parse_marker(issue.get("body") or "")
        if not marker:
            continue
        created = _parse_ts(issue.get("created_at") or "")
        fp = marker.group("fp")
        if fp in seen_existing:
            continue
        seen_existing.add(fp)
        # The daily cap is about what a human was handed today. A high finding is exempt: the cap
        # bounds noise, it must not bury the one that matters.
        if created and created >= day_floor and marker.group("severity") != "high":
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


DEFAULT_BRIEF = "INVARIANTS.md"
# component -> the brief this scan actually read, so an issue names the file its own component has.
BRIEFS: dict[str, str] = {}


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
        "**Reproduced by the cleaner with:**",
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
        f"_A cleaner found and reproduced this. If it is **not** a defect, close it and add a "
        f"line to `{component}/{BRIEFS.get(component, DEFAULT_BRIEF)}` under "
        f"`Known non-findings` — that file is the "
        f"cleaner's brief, and a known non-finding stops being reported._",
        "",
    ])
    return title, body


# --- GitHub ------------------------------------------------------------------------
# Transport, the label convention, the history read and the filing loop are shared with
# goby-tide (`common/issues.py`). What stays here is this product's rule for *which* findings
# to file, which is exactly the part a second product does differently.

MAX_LABELLED_PAGES = common.MAX_LABELLED_PAGES


def list_labelled(repo: str, token: str, label: str | None = None,
                  max_pages: int = MAX_LABELLED_PAGES) -> list[dict] | None:
    """Every issue carrying the cleaner's label, newest first, in any state.

    Closed is included on purpose: a defect the team closed as "not a defect" is the answer
    that must not be asked again next week. `None` when the history cannot be read — a failed
    read and an empty list mean opposite things, and the caller croaks on None.
    """
    return common.list_labelled(repo, token, label or issue_label(), state="all",
                                max_pages=max_pages, http=_http)


def full_name(repo: str) -> str:
    return common.full_name(repo)


def file_findings(repo: str, token: str, sha: str, filed: list[dict]) -> tuple[list[str],
                                                                              list[str]]:
    """(urls, failures). A failure has to reach the caller: a task that exits 0 while a
    reproduced finding was rejected by GitHub is a finding lost with nobody told.

    Each issue carries two labels — `goby-cleaners` and the general `goby` — so a repository
    can filter for one product or for everything goby filed. `decide()` also puts `severity` on
    every item it files, so the shared filer adds `Severity:high|medium|low`: what a human sorts
    by is the same fact the marker and the body line already carry, and the dedupe read still
    asks for `goby-cleaners` alone.
    """
    return common.file_issues(
        repo, token, product(), filed,
        lambda item: render_issue(str(item["finding"].get("component") or ""), item, sha),
        http=_http)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--findings", type=Path, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--issues-per-day", type=int, default=25)
    ap.add_argument("--brief-map", default=None, type=Path,
                    help='JSON {component: brief file} written by the scan')
    ap.add_argument("--out", type=Path, default=None, help="write the plan instead of posting")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    if args.brief_map and args.brief_map.is_file():
        BRIEFS.update(json.loads(args.brief_map.read_text()))

    findings = []
    if args.findings.is_file():
        for line in args.findings.read_text().splitlines():
            if line.strip():
                findings.append(json.loads(line))
    # The component decides the fingerprint and the issue title. A finding without one means
    # the extension was not told which component it is scanning, which would file a defect
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
