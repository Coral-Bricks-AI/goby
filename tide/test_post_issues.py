"""The filing step: one issue per measured smell, and only while it is still over the limit.

No network: `_http` is stubbed, and `decide`/`gone` are pure.
"""
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_tide_post_issues",
                                              HERE / "post_issues.py")
pi = importlib.util.module_from_spec(spec)
sys.modules["goby_tide_post_issues"] = pi
spec.loader.exec_module(pi)

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


def proposal(path="src/cli/entry.ts", check="max_file_lines", metric=1432, threshold=800,
             **kw):
    base = {
        "check": check, "path": path,
        "fingerprint": hashlib.sha256(f"{check}|{path}".encode()).hexdigest()[:12],
        "metric": metric, "threshold": threshold, "unit": "lines",
        "summary": "the command dispatcher, the flag parser and the renderer live in one file",
        "plan": "1. lift the flag parser into `cli/flags.ts`\n2. leave dispatch behind",
        "applied": True, "tests_command": "bun test",
        "tests_output_before": "412 passing (12.1s)",
        "tests_output_after": "412 passing (11.9s)",
        "unverified_reason": "", "risk": "the public `main()` signature and its exit codes",
        "confidence": "high", "diff": "--- a/src/cli/entry.ts\n+++ b/src/cli/flags.ts\n",
        "final_state_tested": True, "untested_changes": "",
    }
    base.update(kw)
    return base


def rendered(proposal_record, check="max_file_lines", path="src/cli/entry.ts") -> str:
    return pi.MARKER.render(token=pi.MARKER.token, fp=proposal_record["fingerprint"],
                            check=check, path=path)


def issue(fp, check="max_file_lines", path="src/cli/entry.ts", days_ago=0, state="open",
          number=1, body=None):
    created = (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"number": number, "state": state, "created_at": created,
            "title": f"[goby-tide] {path}: 1,432 lines (limit 800)",
            "body": body or (rendered({"fingerprint": fp}, check=check, path=path) +
                             "\n\nbody")}


def candidate(path="src/cli/entry.ts", check="max_file_lines"):
    return {"check": check, "path": path, "metric": 1432, "threshold": 800, "unit": "lines",
            "fingerprint": hashlib.sha256(f"{check}|{path}".encode()).hexdigest()[:12]}


# --- the marker ----------------------------------------------------------------------


def test_the_marker_round_trips_including_a_path_with_a_space():
    """A path is arbitrary text. A marker the grammar cannot read is a filing the next sweep
    cannot see, and it files the same smell again every day."""
    for path in ("src/cli/entry.ts", "services/api v2/registry.py", "a b/c d.ts"):
        fp = "0123456789ab"
        parsed = pi.MARKER.parse(rendered({"fingerprint": fp}, path=path))
        assert parsed is not None, path
        assert parsed.group("fp") == fp
        assert parsed.group("path") == path
        assert parsed.group("check") == "max_file_lines"


def test_the_marker_carries_the_version_that_filed_it():
    """The version is what puts a release tag on a timeseries' x-axis. A commit sha is not a
    milestone anybody can read."""
    parsed = pi.MARKER.parse(rendered({"fingerprint": "0123456789ab"}))
    assert parsed is not None
    assert parsed.group("version") == (HERE.parent / "common" / "VERSION").read_text().strip()


def test_a_marker_filed_before_versions_existed_still_parses():
    """Every issue already filed lacks `v=`. If the new grammar rejected those, the next sweep
    would see no fingerprints and file every one of them again."""
    old = ("<!-- goby-tide fp=0123456789ab check=max_file_lines "
           "path=src/cli/entry.ts -->")
    parsed = pi.MARKER.parse(old)
    assert parsed is not None
    assert parsed.group("path") == "src/cli/entry.ts"
    assert parsed.group("version") is None
    # And the same file with a version reads identically apart from that one field.
    parsed = pi.MARKER.parse(rendered({"fingerprint": "0123456789ab"}))
    assert parsed is not None and parsed.group("path") == "src/cli/entry.ts"


def test_a_marker_quoted_in_a_body_is_not_a_filing():
    real = proposal()
    quoted = issue("ffffffffffff", body="**Diff:**\n\n```\n"
                    + rendered(real) + "\n```\n")
    filed, _ = pi.decide([real], [quoted], issues_per_day=5, now=NOW)
    assert [p["fingerprint"] for p in filed] == [real["fingerprint"]]


def test_the_label_can_be_overridden_without_moving_the_marker(monkeypatch):
    monkeypatch.setenv("TIDE_LABEL", "team tide")
    assert pi.issue_label() == "team tide"
    assert pi.product().labels == ["team tide", "goby"]
    monkeypatch.delenv("TIDE_LABEL")
    assert pi.issue_label() == pi.LABEL == "goby-tide"


def test_every_issue_carries_the_product_label_then_the_general_one():
    """`label:goby` finds everything goby filed; `label:goby-tide` finds only the scheduled ones.
    The general label is created once and shared, so it is not the product's own colour."""
    labels = pi.product().labels
    assert labels == ["goby-tide", "goby"]
    assert [label.name for label in pi.product().all_labels()] == ["goby-tide", "goby"]


# --- dedupe: open issues only --------------------------------------------------------


def test_a_smell_already_open_is_not_filed_again():
    p = proposal()
    filed, skipped = pi.decide([p], [issue(p["fingerprint"])], issues_per_day=5, now=NOW)
    assert filed == [] and skipped[0]["reason"] == "already open"


def test_a_closed_issue_does_not_suppress_a_new_one():
    """Code grows back. A file that was split and later passed the threshold again is a new
    issue; the closed one is the record that it was fixed once. The cleaner reads closed issues
    too — a defect closed as "not a defect" must not return — and copying that here would make
    every re-grown smell invisible forever."""
    p = proposal()
    # `decide` is handed what the read returned; a closed issue is not in that list, which is the
    # whole difference from the cleaner. Pinned here so a future change to the read has to come
    # through this test.
    closed_not_read = [i for i in [issue(p["fingerprint"], state="closed")]
                       if i["state"] == "open"]
    filed, _ = pi.decide([p], closed_not_read, issues_per_day=5, now=NOW)
    assert [f["fingerprint"] for f in filed] == [p["fingerprint"]]


def test_the_read_is_scoped_to_this_products_label_and_every_state(monkeypatch, tmp_path):
    """One read, three questions. `open` is "already asked", `not planned` is "asked and answered",
    `completed` is neither — so the read has to see every state, and only the product's own label
    (reading `goby` would pull in the cleaner's history)."""
    seen: list[str] = []

    def fake_http(method, path, token, payload=None):
        seen.append(path)
        if method == "POST" and path.endswith("/issues"):
            return 201, {"html_url": "https://github.com/o/r/issues/1"}
        return 200, []

    monkeypatch.setattr(pi, "_http", fake_http)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    args = ["--proposals", str(tmp_path / "p.jsonl"), "--candidates", str(tmp_path / "c.jsonl"),
            "--repo", "o/r", "--sha", "a" * 40, "--issues-per-day", "5"]
    (tmp_path / "p.jsonl").write_text(json.dumps(proposal()) + "\n")
    (tmp_path / "c.jsonl").write_text(json.dumps(candidate()) + "\n")
    assert pi.main(args) == 0
    reads = [p for p in seen if p.startswith("/repos/o/r/issues?")]
    assert reads, seen
    for path in reads:
        assert "state=all" in path, "a `not planned` close is invisible to an open-only read"
        assert "labels=goby-tide" in path, "reading `goby` would mix in the cleaner's history"


def test_a_duplicate_inside_one_sweep_files_once():
    p = proposal()
    filed, skipped = pi.decide([p, p], [], issues_per_day=5, now=NOW)
    assert len(filed) == 1 and skipped[0]["reason"] == "duplicate in this run"


def test_the_daily_cap_counts_what_a_human_was_handed_today():
    other = [issue("aaaaaaaaaaaa", path="src/other.ts", days_ago=0)]
    filed, skipped = pi.decide([proposal()], other, issues_per_day=1, now=NOW)
    assert filed == [] and skipped[0]["reason"] == "daily budget spent"


def test_yesterday_does_not_spend_todays_budget():
    other = [issue("aaaaaaaaaaaa", path="src/other.ts", days_ago=2)]
    filed, _ = pi.decide([proposal()], other, issues_per_day=1, now=NOW)
    assert len(filed) == 1


def test_the_cap_is_independent_of_how_many_smells_one_file_has():
    two = [proposal(), proposal(check="max_file_imports", metric=51)]
    filed, _ = pi.decide(two, [], issues_per_day=5, now=NOW)
    assert len(filed) == 2


# --- closing what is gone ------------------------------------------------------------


def test_an_open_issue_whose_smell_stopped_firing_is_closed():
    gone_issue = issue(candidate("src/big.ts")["fingerprint"], path="src/big.ts")
    still = issue(candidate()["fingerprint"], path="src/cli/entry.ts")
    closed = pi.gone([candidate()], [gone_issue, still])
    assert [i["number"] for i in closed] == [gone_issue["number"]]


def test_a_smell_over_the_model_budget_is_not_closed():
    """`candidates` is every measurement, not the picked subset: a smell that is merely over this
    sweep's model-call budget is still there, and closing it would be a lie."""
    open_issue = issue(candidate("src/big.ts")["fingerprint"], path="src/big.ts")
    assert pi.gone([], [open_issue]) == [open_issue]
    assert pi.gone([candidate("src/big.ts")], [open_issue]) == []


def test_the_close_comment_names_what_was_measured(monkeypatch):
    closed: list[tuple[str, str]] = []

    def fake_http(method, path, token, payload=None):
        if method == "POST" and path.endswith("/comments"):
            closed.append(("comment", payload["body"]))
            return 201, {}
        if method == "PATCH":
            closed.append(("patch", json.dumps(payload)))
            return 200, {}
        return 200, []

    ok = pi.common.close_issue("o/r", "tok", 7, "`src/big.ts` is no longer over its threshold",
                               http=fake_http)
    assert ok and [kind for kind, _ in closed] == ["comment", "patch"]
    assert "no longer over its threshold" in closed[0][1]


# --- rendering -----------------------------------------------------------------------


def test_the_title_is_the_measurement():
    title, _ = pi.render_issue(proposal(), "a" * 40)
    assert title == "[goby-tide] src/cli/entry.ts: 1,432 lines (limit 800)"


def test_two_checks_on_one_file_do_not_produce_the_same_title():
    lines, _ = pi.render_issue(proposal(), "a" * 40)
    imports, _ = pi.render_issue(proposal(check="max_file_imports", metric=51,
                                          threshold=40), "a" * 40)
    imports = imports.replace("1,432 lines", "51 imports").replace("(limit 800)", "(limit 40)")
    assert lines != imports


def test_the_issue_carries_the_plan_the_risk_and_both_runs():
    _, body = pi.render_issue(proposal(), "a" * 40)
    assert "cli/flags.ts" in body, "the plan is the deliverable"
    assert "the public `main()` signature" in body, "the risk is what a reviewer checks"
    assert "412 passing (12.1s)" in body and "412 passing (11.9s)" in body
    assert "**Verified in a container**" in body
    assert "--- a/src/cli/entry.ts" in body, "the diff is the harness's evidence"
    assert pi.MARKER.parse(body).group("check") == "max_file_lines"


def test_an_unverified_proposal_says_so_and_says_why():
    _, body = pi.render_issue(proposal(applied=False, tests_output_before="",
                                       tests_output_after="", diff="",
                                       unverified_reason="the suite needs postgres"),
                              "a" * 40)
    assert "**Not verified in a container**" in body
    assert "the suite needs postgres" in body
    assert "Verified in a container" not in body


def test_the_diff_is_folded_away_but_the_claim_is_not():
    """A 12k-character diff at the top of a body is one nobody reads, so it folds. What must not
    fold is the sentence saying which state it is: that is what a reader decides on."""
    _, body = pi.render_issue(proposal(), "a" * 40)
    assert "<details>" in body and "</details>" in body
    start = body.index("<details>")
    assert "this is what the after-run tested" in body[:start], "the claim stays visible"
    assert "--- a/src/cli/entry.ts" in body[start:], "the diff is inside the fold"
    # The blank lines are what make GitHub render the fence as code inside `<details>`.
    assert "<summary>diff — 2 lines</summary>\n\n```diff\n" in body
    assert "the plan is the deliverable" not in body[start:], "only the diff is folded"


def test_a_sandbox_that_changed_after_the_report_is_not_called_tested():
    """#118: the agent applied two stages, verified the first, and said so — and the attached diff
    was both. The harness cannot see the difference, so the emit tool asks, and this is the answer
    being told to the reader instead of hidden."""
    _, body = pi.render_issue(proposal(final_state_tested=False,
                                       untested_changes="the second half of the split, in "
                                                        "`cli/flags.ts`, was applied after the run"),
                              "a" * 40)
    assert "this is what the after-run tested" not in body
    assert "different state from the one the after-run tested" in body
    assert "the second half of the split" in body
    assert "--- a/src/cli/entry.ts" in body, "the change is still attached, and still labelled"


def test_a_diff_from_a_run_that_never_happened_is_not_called_tested():
    """#121/#122: the prompt's own escape hatch is `applied: false` with a reason, and the sandbox
    still holds the change. The body said "not verified" and "this is what the after-run tested"
    four lines apart."""
    _, body = pi.render_issue(proposal(applied=False, unverified_reason="no test command",
                                       tests_output_before="", tests_output_after=""),
                              "a" * 40)
    assert "**Not verified in a container**" in body
    assert "this is what the after-run tested" not in body
    assert "nothing ran against it, so this is a proposal" in body
    assert "--- a/src/cli/entry.ts" in body, "the change is still attached, and still labelled"


def test_the_folded_summary_counts_the_change_not_the_clipping():
    """#123/#124: the summary is the only size signal before the fold is opened, and it counted
    the clipped text — 424 lines for a 500-line change, next to a note saying 500."""
    body = "\n".join(f"+ line {n} of the refactor" for n in range(500))
    _, rendered = pi.render_issue(proposal(diff=body), "a" * 40)
    assert "<summary>diff — 500 lines</summary>" in rendered
    assert "…diff truncated: showing" in rendered


def test_a_proposal_from_before_the_question_is_not_presented_as_unverified():
    """A record with no `final_state_tested` predates the field; it gets the old sentence rather
    than the alarming one, because there is no evidence it was untested."""
    record = proposal()
    del record["final_state_tested"]
    _, body = pi.render_issue(record, "a" * 40)
    assert "this is what the after-run tested" in body
    assert "different state from the one the after-run tested" not in body


def test_a_verified_proposal_with_no_diff_is_not_dressed_up_as_a_change():
    """`applied: true` with an empty sandbox means the after-run cannot be compared against
    anything, and the body must not imply it can."""
    _, body = pi.render_issue(proposal(diff=""), "a" * 40)
    assert "no change was left in the sandbox" in body.lower()
    assert "**The change the sweep applied**" not in body


# --- filing against a stubbed API ----------------------------------------------------


class FakeGitHub:
    def __init__(self, existing=(), create_status=201):
        self.created, self.labels, self.existing = [], [], list(existing)
        self.create_status = create_status

    def __call__(self, method, path, token, payload=None):
        if path.startswith("/repos/o/r/labels"):
            self.labels.append(payload["name"])
            return 422, {"message": "already exists"}
        if method == "GET" and "/issues?labels=" in path:
            return 200, self.existing
        if method == "POST" and path.endswith("/issues"):
            self.created.append(payload)
            if self.create_status != 201:
                return self.create_status, {"message": "Resource not accessible by integration"}
            return 201, {"html_url": f"https://github.com/o/r/issues/{100 + len(self.created)}"}
        return 200, []


def test_every_issue_is_filed_under_both_labels(monkeypatch):
    gh = FakeGitHub()
    monkeypatch.setattr(pi, "_http", gh)
    urls, failures = pi.file_proposals("o/r", "tok", "c" * 40,
                                       [proposal(), proposal(check="max_file_imports")])
    assert failures == [] and len(urls) == 2
    assert [c["labels"] for c in gh.created] == [["goby-tide", "goby"], ["goby-tide", "goby"]]
    assert gh.labels == ["goby-tide", "goby"]
    assert all("assignees" not in c for c in gh.created), "humans route issues"


def test_a_rejected_filing_fails_the_task(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(pi, "_http", FakeGitHub(create_status=403))
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    (tmp_path / "p.jsonl").write_text(json.dumps(proposal()) + "\n")
    (tmp_path / "c.jsonl").write_text(json.dumps(candidate()) + "\n")
    rc = pi.main(["--proposals", str(tmp_path / "p.jsonl"), "--candidates",
                  str(tmp_path / "c.jsonl"), "--repo", "o/r", "--sha", "a" * 40,
                  "--issues-per-day", "5"])
    assert rc == 1
    plan = json.loads(capsys.readouterr().out)
    assert plan["failures"] and "403" in plan["failures"][0]


def test_a_failed_listing_files_and_closes_nothing(monkeypatch, tmp_path):
    """An empty list and a failed read mean opposite things; treating them alike re-files
    everything already open."""
    monkeypatch.setattr(pi, "_http", lambda *a, **k: (502, "bad gateway"))
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    (tmp_path / "p.jsonl").write_text(json.dumps(proposal()) + "\n")
    (tmp_path / "c.jsonl").write_text("")
    assert pi.main(["--proposals", str(tmp_path / "p.jsonl"), "--candidates",
                    str(tmp_path / "c.jsonl"), "--repo", "o/r", "--sha", "a" * 40,
                    "--issues-per-day", "5", "--close-gone"]) == 1


def test_a_plan_only_run_posts_nothing(monkeypatch, tmp_path, capsys):
    called = []
    monkeypatch.setattr(pi, "_http", lambda *a, **k: called.append(a))
    (tmp_path / "p.jsonl").write_text(json.dumps(proposal()) + "\n")
    (tmp_path / "c.jsonl").write_text(json.dumps(candidate()) + "\n")
    out = tmp_path / "plan.json"
    assert pi.main(["--proposals", str(tmp_path / "p.jsonl"), "--candidates",
                    str(tmp_path / "c.jsonl"), "--repo", "o/r", "--sha", "a" * 40,
                    "--issues-per-day", "5", "--out", str(out)]) == 0
    assert called == [] and json.loads(out.read_text())["filed"]


def test_the_footer_names_both_ways_to_dismiss_it_and_which_one_to_prefer():
    """Two close reasons mean opposite things, so the footer has to be explicit: `known` is the
    durable, reviewable record, `not planned` works but cannot be taken back, and `completed`
    means fixed — after which a file that grows back is a new finding."""
    _, body = pi.render_issue(proposal(), "a" * 40)
    footer = body.split("**What must not change**")[1]
    assert "`.goby/tide.json`" in footer
    assert '"check": "max_file_lines", "path": "src/cli/entry.ts"' in footer
    assert "`known` entry is measured and then skipped" in footer
    assert "Closing this issue as **not planned** also stops it" in footer
    assert "cannot be taken back" in footer
    assert "Closing as *completed* does not stop it" in footer


def test_the_known_snippet_can_be_placed_in_the_file_as_printed():
    """The footer is the only lever a reader has to stop a smell being filed, and it printed a bare
    `{check,path,reason}` object. `.goby/tide.json` reads `known`, so a reader who followed it
    verbatim created a file the sweep could not see and the smell came back — the outcome the
    paragraph above it promises to prevent (#100)."""
    _, body = pi.render_issue(proposal(), "a" * 40)
    footer = body.split("**What must not change**")[1]
    json_block = footer.split("```json", 1)[1].split("```", 1)[0]
    document = json.loads(json_block)
    assert list(document) == ["known"], "a pasteable document, not a bare entry"
    (entry,) = document["known"]
    assert entry["check"] == "max_file_lines" and entry["path"] == "src/cli/entry.ts"
    assert entry["reason"].strip()


def test_a_truncated_block_says_so_and_names_where_the_rest_comes_from():
    """#101's diff was cut mid-function at 12k characters with nothing to say it had been cut: the
    issue looked complete, and the one thing a reviewer needed — the end of the change — was
    missing with no marker. The cap stays; the silence does not."""
    body = "\n".join(f"+ line {n} of the refactor" for n in range(4000))
    _, rendered = pi.render_issue(proposal(diff=body), "a" * 40)
    assert "…diff truncated: showing" in rendered
    assert "of 4,000 lines" in rendered
    assert "reproducible by following the plan above" in rendered
    # Cut on a line boundary: a diff that ends mid-line cannot be applied or read.
    tail = rendered.split("```diff", 1)[1]
    assert "+ line 3999 of the refactor" not in tail
    truncated = [line for line in tail.splitlines() if line.startswith("+ line")]
    assert truncated and truncated[-1].endswith("of the refactor")


def test_a_block_under_the_cap_is_not_marked():
    _, rendered = pi.render_issue(proposal(diff="+ one line\n"), "a" * 40)
    assert "truncated" not in rendered


def test_every_block_that_can_be_cut_uses_the_same_marker():
    """Prose and evidence are both evidence when a reader is deciding to approve a refactor: a
    plan that stops mid-step without saying so is the same failure as a truncated diff."""
    long = "\n".join(f"step {n}" for n in range(3000))
    _, rendered = pi.render_issue(proposal(summary=long, plan=long, risk=long), "a" * 40)
    for what in ("summary truncated", "plan truncated", "risk truncated"):
        assert f"…{what}" in rendered, what


def test_a_single_line_block_cut_mid_line_counts_characters_not_lines():
    """A one-paragraph summary or a one-line test command has no line boundary to cut on. Counting
    lines made the note read "showing 1 of 1 lines" — a claim that nothing was omitted, printed
    directly under text that had been cut mid-sentence."""
    paragraph = "one long paragraph about the file " * 300
    _, rendered = pi.render_issue(proposal(summary=paragraph), "a" * 40)
    assert "…summary truncated: showing 4,000 of" in rendered
    assert "characters" in rendered
    assert "1 of 1 lines" not in rendered


def test_a_check_that_did_not_run_cannot_close_its_issues():
    """`todo_age` without history measures nothing. Closing its open issues would put "no longer
    over its threshold" on a question this sweep never asked."""
    stale = issue(candidate("src/rot.ts", "todo_age")["fingerprint"], check="todo_age",
                  path="src/rot.ts")
    measured = {"max_file_lines", "max_todos"}
    assert pi.gone([], [stale], measured) == []
    assert pi.gone([], [stale], measured | {"todo_age"}) == [stale]


def test_an_issue_with_no_readable_check_is_left_alone():
    """A body whose marker cannot be parsed says nothing about which check filed it."""
    unparsable = {"number": 9, "title": "x", "body": "no marker here"}
    assert pi.gone([], [unparsable], {"max_file_lines"}) == []


def test_a_close_as_not_planned_mutes_the_check_on_that_path():
    """Two close reasons mean opposite things. `not planned` is a human deciding not to; asking
    again every sweep is exactly the noise this product exists to avoid."""
    p = proposal()
    closed = issue(p["fingerprint"], state="closed")
    # The REST spelling, which is what `common.list_labelled` actually reads. Comparing against
    # GraphQL's `NOT_PLANNED` made the mute never fire, and looked like the old behaviour.
    closed["state_reason"] = "not_planned"
    muted = pi.muted_issues([closed])
    filed, skipped = pi.decide([p], [], muted=muted, issues_per_day=5, now=NOW)
    assert filed == []
    assert skipped[0]["reason"] == "closed as not planned in #1"


def test_a_close_as_completed_frees_the_fingerprint():
    """`completed` says the smell was dealt with. Code grows back, and a file that passes the
    threshold again is a new finding, not a duplicate of the one that was fixed."""
    p = proposal()
    closed = issue(p["fingerprint"], state="closed")
    closed["state_reason"] = "COMPLETED"
    assert pi.muted_issues([closed]) == {}
    filed, _ = pi.decide([p], [], muted=pi.muted_issues([closed]),
                         issues_per_day=5, now=NOW)
    assert len(filed) == 1


def test_muting_is_per_check_and_path_not_per_file():
    """A muted `max_file_lines` on a file says nothing about its imports: the human decided about
    one measurement, and the other one is a different change."""
    lines = proposal()
    closed = issue(lines["fingerprint"], state="closed")
    closed["state_reason"] = "NOT_PLANNED"
    imports = proposal(check="max_file_imports", metric=51)
    filed, _ = pi.decide([imports], [], muted=pi.muted_issues([closed]),
                         issues_per_day=5, now=NOW)
    assert [f["check"] for f in filed] == ["max_file_imports"]


def test_a_muted_suppression_is_reported_in_the_plan(monkeypatch, tmp_path, capsys):
    """A permanent mute that nothing logs is the unexplained silence the rest of this product
    argues against: the plan names the issue that holds the decision."""
    closed = issue("aaaaaaaaaaaa", state="closed")
    closed["state_reason"] = "NOT_PLANNED"

    def fake_http(method, path, token, payload=None):
        if method == "GET" and "/issues?" in path:
            return 200, [closed]
        return 200, []

    monkeypatch.setattr(pi, "_http", fake_http)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    (tmp_path / "p.jsonl").write_text("")
    (tmp_path / "c.jsonl").write_text("")
    assert pi.main(["--proposals", str(tmp_path / "p.jsonl"), "--candidates",
                    str(tmp_path / "c.jsonl"), "--repo", "o/r", "--sha", "a" * 40,
                    "--issues-per-day", "5"]) == 0
    assert json.loads(capsys.readouterr().out)["muted"] == [1]


def test_the_close_reason_is_read_in_the_spelling_the_api_uses():
    """The REST issues endpoint spells it `not_planned`; GraphQL spells it `NOT_PLANNED`. A fixture
    that only carries the upper-case form hid a mute that could never fire."""
    for spelling in ("not_planned", "NOT_PLANNED", " Not_Planned "):
        closed = issue("aaaaaaaaaaaa", state="closed")
        closed["state_reason"] = spelling
        assert pi.is_not_planned(closed), spelling
    for other in ("completed", "COMPLETED", "reopened", None, ""):
        closed = issue("aaaaaaaaaaaa", state="closed")
        closed["state_reason"] = other
        assert not pi.is_not_planned(closed), other
