#!/usr/bin/env python3
"""Put the `Severity:*` label on the issues that were filed before it existed.

    python3 scripts/backfill_severity.py --repo Coral-Bricks-AI/www            # report
    python3 scripts/backfill_severity.py --repo Coral-Bricks-AI/www --apply    # write

`cleaners/post_findings.py` has written the severity into every finding's marker since the
first filing, and into the body header beside it. What is missing on the back catalogue is the
label — the one field an issue list can be filtered by — so this reads the marker and adds it.

The severity is *read*, never guessed:

- a marker the cleaner's own grammar parses carries `severity=`, and that is the value;
- anything else — a tide issue (a smell has no severity), a body with only a quoted marker, a
  hand-written issue — is **skipped and reported**, because a label that means "we derived this"
  must not be handed out where nothing was measured.

Nothing here is a second source of truth: the grammar is `post_findings.parse_marker`, the label
names are `common.SEVERITY`, and the API is `common._http`. Run it again and it is a no-op.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _load():
    """`common/issues.py` and the cleaner's grammar, from the repository as it is checked out.

    The cleaners image is not involved: this runs on a laptop with a token, so the paths are
    the repository's own, and `post_findings.py` bootstraps `common` for itself.
    """
    sys.path.insert(0, str(REPO / "cleaners"))
    import post_findings as cleaners  # noqa: E402 — after the path bootstrap above
    return cleaners, cleaners.common


cleaners, common = _load()

# The products whose issues are in scope: everything goby filed, whichever product filed it. A
# repository that has used its own label (`CLEANERS_LABEL`) keeps the general one on every
# issue, so this reads the union without being told how each repository names things.
GENERAL = common.GENERAL
SEVERITY_NAMES = {label.name for label in common.SEVERITY}


def derived(issue: dict) -> str | None:
    """The severity the leading marker records, or None when it records none."""
    marker = cleaners.parse_marker(issue.get("body") or "")
    return marker.group("severity") if marker else None


def plan(issues: list[dict]) -> tuple[list[dict], list[dict]]:
    """(to_label, skipped), decided from the body and the labels already on the issue.

    Idempotent by construction: an issue that already carries a `Severity:*` label is not
    touched, whether or not it agrees with the marker. A disagreement is reported instead —
    somebody made that decision by hand, and a backfill is not the thing that overrules it.
    """
    todo, skipped = [], []
    for issue in issues:
        severity = derived(issue)
        label = common.severity_label(severity)
        if label is None:
            skipped.append({"number": issue.get("number"),
                            "reason": "no severity in the marker",
                            "title": issue.get("title") or ""})
            continue
        have = sorted({entry.get("name") for entry in issue.get("labels") or []} & SEVERITY_NAMES)
        if have == [label.name]:
            skipped.append({"number": issue.get("number"), "reason": "already labelled",
                            "title": issue.get("title") or ""})
            continue
        if have:
            skipped.append({"number": issue.get("number"),
                            "reason": f"labelled {have[0]}, marker says {label.name}",
                            "title": issue.get("title") or ""})
            continue
        todo.append({"number": issue.get("number"), "label": label.name,
                     "severity": severity, "title": issue.get("title") or ""})
    return todo, skipped


def create_labels(repo: str, token: str, http=None) -> list[str]:
    """The three severity labels, whether or not this run needs all of them.

    All three, unlike a scan: the backfill exists so a repository's whole history is filterable,
    and a filter list that depends on which severities happened to be filed is not. 422 is
    "already exists".
    """
    http = http or common._http
    created = []
    for label in common.SEVERITY:
        st, _ = http("POST", f"/repos/{repo}/labels", token,
                     {"name": label.name, "color": label.color,
                      "description": label.description})
        if st not in (201, 422):
            print(f"warning: label {label.name} -> HTTP {st}", file=sys.stderr)
        else:
            created.append(label.name)
    return created


def apply(repo: str, token: str, todo: list[dict], http=None) -> list[str]:
    """Add each label, one call per issue: failures are returned, never swallowed."""
    http = http or common._http
    failures = []
    for item in todo:
        st, resp = http("POST", f"/repos/{repo}/issues/{item['number']}/labels", token,
                        {"labels": [item["label"]]})
        if st not in (200, 201):
            failures.append(f"#{item['number']} -> HTTP {st}: {str(resp)[:120]}")
            print(f"error: {item['label']} on #{item['number']} -> HTTP {st}", file=sys.stderr)
    return failures


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True, help="owner/name, or a bare name under Coral-Bricks-AI")
    ap.add_argument("--apply", action="store_true",
                    help="write the labels; without it this only reports the plan")
    ap.add_argument("--json", action="store_true", help="print the plan as JSON")
    args = ap.parse_args(argv)

    repo = common.full_name(args.repo)
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("error: GITHUB_TOKEN is required", file=sys.stderr)
        return 2

    listed = common.list_labelled(repo, token, GENERAL, state="all")
    if listed is None:
        # Croak rather than half-label: a truncated read is a subset, and a backfill that covers
        # some of the history is worse than one that ran twice.
        print("error: cannot read the issues; nothing labelled", file=sys.stderr)
        return 1

    todo, skipped = plan(listed)
    result = {"repo": repo, "read": len(listed), "to_label": todo, "skipped": skipped,
              "created": [], "failures": []}
    if args.apply and todo:
        result["created"] = create_labels(repo, token)
        result["failures"] = apply(repo, token, todo)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for item in todo:
            print(f"{item['number']:>6}  {item['label']:<16} {item['title'][:96]}")
        for item in skipped:
            print(f"{item['number']:>6}  {'-' * 16} {item['reason']}: {item['title'][:64]}")
        print(f"\n{len(listed)} issues read · {len(todo)} to label · {len(skipped)} skipped"
              f" · {'applied' if args.apply else 'dry run, nothing written'}")
    return 1 if result["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
