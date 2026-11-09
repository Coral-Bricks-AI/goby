#!/usr/bin/env python3
"""What every goby product shares when it files a GitHub issue.

    from common.issues import GENERAL, Label, Marker, Product, file_issues, list_labelled

Three products file issues: `goby-cleaners` after a merge, `goby-tide` on a schedule, and
whatever comes next. The *policy* differs and stays in each product (what a duplicate is,
whether a severity escapes the daily cap, how the body reads). The *plumbing* does not, and
this is it: the API call, the two-label convention, the history read, the filing loop, and
closing an issue whose finding no longer reproduces.

Nothing here branches on which product is calling. A product is a value — its label, its
marker, its colour — and it is passed in. If a future product needs a different *decision*,
that decision belongs in its own `decide()` next to this module, not as an `if` in here.

Three conventions worth stating once, because each was learned the hard way:

- **Labels for humans, one read for dedupe.** An issue carries the product's own label *and*
  the general `goby` label, so `label:goby` finds everything goby filed and `label:goby-tide`
  finds one product. A product that measured a severity adds `Severity:high|medium|low`
  between them: a label is the only field an issue list can be filtered or sorted by, and the
  body line the cleaner already writes is neither. Dedupe reads the product's own label only:
  the two products file findings of different kinds, so they never collide, and reading the
  general label would make one product's page budget and fingerprints depend on the other's
  history. **No label is ever read back** — the read stays on the product label alone, because
  a filing made before a label existed carries no such label and would drop out of the history
  and be filed again.
- **The marker is the only record of a filing.** It is the first thing in the body and
  nowhere else; a marker quoted later is evidence someone pasted (a scan of this repository
  has markers in its issue bodies). Each product's grammar is its own, next to the code that
  writes it, because a grammar is only correct with the writer it was written for.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from typing import Callable
from urllib.parse import quote, urlencode

API = os.environ.get("GITHUB_API_URL", "https://api.github.com")

# The label every goby product puts on its issues, beside its own. Filtering for all of goby
# is `label:goby`; filtering for one product is `label:goby-tide`.
GENERAL = "goby"


@dataclass(frozen=True)
class Label:
    name: str
    color: str = "0e8a16"
    description: str = ""


# The severity a product files under when it measured one. A label, not a body line, because a
# label is the only field an issue list can be filtered or sorted by. The name carries both
# halves (`Severity:high`), so a repository's own `high` label stays free and
# `label:"Severity:high"` cannot pick up somebody else's issues.
SEVERITY: tuple[Label, ...] = (
    Label("Severity:high", "b60205", "act on it: wrong output, lost data, a broken path"),
    Label("Severity:medium", "d93f0b", "schedule it: wrong behaviour on a narrow path"),
    Label("Severity:low", "fbca04", "worth knowing: naming, docs, dead code"),
)


def severity_label(severity: object) -> Label | None:
    """The label for a severity value, or None when the value is not one of ours.

    A value outside the vocabulary is not a severity anybody defined, and inventing
    `Severity:critical` would put a word in the repository's label list that no reader chose,
    so the filing goes out without a severity label and the caller says so.
    """
    if not isinstance(severity, str):
        return None
    for label in SEVERITY:
        if label.name == f"Severity:{severity}":
            return label
    return None


@dataclass
class Marker:
    """The comment that identifies one filing, and the only thing dedupe reads.

    `pattern` is this product's own grammar and `template` is the writer it was written for:
    a grammar is not reusable across products, because the fields differ and so does what may
    contain a space. `parse` only accepts the marker at the *start* of the body — a marker
    quoted inside evidence is not a filing, and reading one there once suppressed the real
    finding it named.
    """

    token: str
    pattern: str
    template: str

    def __post_init__(self) -> None:
        self.regex = re.compile(self.pattern)

    def render(self, **fields: object) -> str:
        return self.template.format(**fields)

    def parse(self, body: str) -> re.Match | None:
        return self.regex.match((body or "").lstrip())


@dataclass(frozen=True)
class Product:
    """What a product calls itself when it files. A value, not a mode."""

    label: Label
    marker: Marker
    # The general label is on every goby issue; a product may add its own extras.
    extras: tuple[Label, ...] = (Label(GENERAL, "1d76db", "filed by a goby product"),)

    @property
    def labels(self) -> list[str]:
        """Every label a new issue carries: the product's own first, then the general one.

        Order is not decoration. GitHub's issue list defaults to the first, and a human
        scanning a repo should see which product filed it before they see that goby did.
        """
        return self.labels_for(None)

    def labels_for(self, severity: object) -> list[str]:
        """The same list for one filing, with its severity between the product and `goby`.

        Second, because it is the field a human sorts by and GitHub shows these in order. It is
        presentation only: `marker_index` and every `decide()` read the body and the state, never
        the labels, so a person who relabels an issue changes what they see and not what the
        next run files.
        """
        label = severity_label(severity)
        return [self.label.name, *([label.name] if label else []),
                *(extra.name for extra in self.extras)]

    def all_labels(self) -> tuple[Label, ...]:
        return (self.label, *self.extras)

    def renamed(self, label: str | None) -> "Product":
        """The same product filing under another label (`CLEANERS_LABEL`, `TIDE_LABEL`).

        The marker token does not move: it is the filing's identity, and a repository that
        renames its label still needs its already-filed issues to be visible to dedupe.
        """
        return self if not label else replace(self, label=replace(self.label, name=label))


def full_name(repo: str) -> str:
    return repo if "/" in repo else f"Coral-Bricks-AI/{repo}"


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


def issues_url(repo: str, label: str, page: int, state: str = "all") -> str:
    """The dedupe read's URL, with the label encoded.

    Interpolating the label raw meant `team cleaners` produced a request line with a space in
    it: the read failed, and nothing was filed under that label at all.
    """
    return f"/repos/{repo}/issues?" + urlencode(
        {"labels": label, "state": state, "per_page": 100, "page": page}, quote_via=quote)


# Dedupe has to see every issue carrying the label, in *any* state: a closed "not a bug" is
# the answer that must not be asked again, and GitHub lists newest first, so a truncated read
# loses precisely the oldest verdicts. The bound is therefore on **pages walked**, not on
# issues returned: a page count has no boundary to get wrong, where an issue count creates a
# cliff — with a 2000-issue bound, 2099 issues read cleanly and 2100 refused, although both
# lists are complete (#1298, and #1296 before it). 100 pages is 10 000 issues, a little over a
# year at the shipped `issues_per_day` 25 — the cap bounds noise, not history, and a year of
# files a human handed out is the window that decides whether a defect is being asked again.
MAX_LABELLED_PAGES = 100


def list_labelled(repo: str, token: str, label: str, *, state: str = "all",
                  max_pages: int = MAX_LABELLED_PAGES, http=None) -> list[dict] | None:
    """Every issue carrying the label in `state`, newest first.

    None when that cannot be known — a failed read, or a list longer than `max_pages` is
    willing to walk. An empty list and a failed read mean opposite things ("nothing filed
    yet" versus "do not know what is filed"), and treating them alike re-files every open
    finding; the same is true of a truncated read, which is why it fails rather than
    returns a prefix. The caller decides what to do with None; this function refuses to
    guess.
    """
    http = http or _http
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        st, body = http("GET", issues_url(repo, label, page, state), token)
        if st != 200 or not isinstance(body, list):
            print(f"error: list issues ({label}, {state}) -> HTTP {st}: {str(body)[:160]}",
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
    st, body = http("GET", issues_url(repo, label, max_pages + 1, state), token)
    if st == 200 and isinstance(body, list) and not body:
        return out
    print(f"error: more than {max_pages} pages of issues carry the {label} label "
          f"({state}); the dedupe read is incomplete, so nothing is filed. Raise "
          f"MAX_LABELLED_PAGES or prune the closed ones.", file=sys.stderr)
    return None


def ensure_labels(repo: str, token: str, product: Product, *,
                  severities: tuple[Label, ...] = (), http=None) -> None:
    """Create the product's label, the general one, and the severities this run files under.

    Only the severities actually filed: a repository that never receives a `low` should not
    sprout a label for one, and the other two are created the first time they are needed. 422 is
    "already exists".
    """
    http = http or _http
    for label in (*product.all_labels(), *severities):
        st, _ = http("POST", f"/repos/{repo}/labels", token,
                     {"name": label.name, "color": label.color,
                      "description": label.description})
        if st not in (201, 422):
            print(f"warning: label {label.name} -> HTTP {st}", file=sys.stderr)


def _severity_of(item: object) -> str | None:
    """The severity an item carries, or None when it carries none we can file under.

    `severity` is the vocabulary's own name, not one product's field: a product that ranks what
    it files puts it on the item in its own `decide()` (`cleaners/post_findings.py`), and one
    that does not (`goby-tide`, where the threshold is the filter) leaves it off and files
    without the label. Nothing here branches on which product is calling.
    """
    value = item.get("severity") if isinstance(item, dict) else None
    if value is None:
        return None
    if isinstance(value, str) and severity_label(value):
        return value
    print(f"warning: severity {value!r} is not one of "
          f"{', '.join(label.name for label in SEVERITY)}; filing without it",
          file=sys.stderr)
    return None


def file_issues(repo: str, token: str, product: Product,
                items: list, render: Callable[[object], tuple[str, str]],
                http=None) -> tuple[list[str], list[str]]:
    """(urls, failures). A failure has to reach the caller: a task that exits 0 while a
    reproduced finding was rejected by GitHub is a finding lost with nobody told.

    `render` is the product's own body: the facts differ per product, so the writer is passed
    in rather than switched on here. Each issue carries the product label, the item's severity
    when it has one, and `goby` — in that order.
    """
    http = http or _http
    urls: list[str] = []
    failures: list[str] = []
    if not items:
        return urls, failures
    # Resolved once per item: a value outside the vocabulary is a warning, not a second one per
    # request, and the labels this run needs are the labels it is about to write.
    sized = [(item, _severity_of(item)) for item in items]
    used: dict[str, Label] = {}
    for _, severity in sized:
        label = severity_label(severity)
        if label:
            used[label.name] = label
    ensure_labels(repo, token, product, severities=tuple(used.values()), http=http)
    for item, severity in sized:
        title, body = render(item)
        st, resp = http("POST", f"/repos/{repo}/issues", token,
                        {"title": title, "body": body,
                         "labels": product.labels_for(severity)})
        if st == 201 and isinstance(resp, dict):
            urls.append(resp["html_url"])
            continue
        failures.append(f"create issue HTTP {st}: {str(resp)[:160]}")
        print(f"error: {failures[-1]}", file=sys.stderr)
    return urls, failures


def close_issue(repo: str, token: str, number: int, comment: str, http=None) -> bool:
    """Comment, then close. Returns False if either call failed.

    A finding that stopped reproducing is the only thing that closes an issue here, and the
    comment is why: "no longer fires, measured at <sha>" is what lets a later reader tell a
    fixed smell from a dismissed one.
    """
    http = http or _http
    ok = True
    st, _ = http("POST", f"/repos/{repo}/issues/{number}/comments", token, {"body": comment})
    if st not in (200, 201):
        print(f"warning: comment on #{number} -> HTTP {st}", file=sys.stderr)
        ok = False
    st, _ = http("PATCH", f"/repos/{repo}/issues/{number}", token,
                 {"state": "closed", "state_reason": "completed"})
    if st not in (200, 201):
        print(f"warning: close #{number} -> HTTP {st}", file=sys.stderr)
        return False
    return ok


def marker_index(issues: list[dict], marker: Marker) -> dict[str, dict]:
    """fingerprint -> the issue carrying it, from the leading marker only.

    One filing, one marker. Anything quoted later in a body is part of the evidence, not a
    second filing, and a quarantine of quoted markers is what stops one issue from
    suppressing the finding it quotes.
    """
    out: dict[str, dict] = {}
    for issue in issues:
        parsed = marker.parse(issue.get("body") or "")
        if not parsed:
            continue
        fp = parsed.group("fp")
        if fp not in out:
            out[fp] = issue
    return out
