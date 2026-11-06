"""Tests for the filing step: fingerprinting, dedupe, budget, and one issue per finding.

No network: `_http` is stubbed, and `decide()` is pure.
"""
import importlib.util
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_cleaners_post", HERE / "post_findings.py")
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
COMPONENT = "services/api"


def finding(title="slot over-admitted", file="services/api/registry.py",
            severity="medium", component=COMPONENT, **kw):
    base = {
        "component": component,
        "title": title, "severity": severity, "file": file, "line": 921,
        "invariant": "no backend may be sent more than max_in_flight",
        "trigger": "three acquires on a two-slot backend",
        "observed": "the third acquire returns the backend",
        "expected": "the third acquire returns None",
        "repro_command": "python3 /tmp/sandbox/repro1.py",
        "repro_output": "(0,'be0',1)\n(1,'be0',2)\n(2,'be0',3)",
        "flip_command": "python3 /tmp/sandbox/repro1.py  # after changing < to <=",
        "flip_output": "(2, None, 2)",
        "confidence": "high",
    }
    base.update(kw)
    return base


def issue(fp, component=COMPONENT, severity="medium", days_ago=0, state="open", number=1,
          body=None):
    created = (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"number": number, "state": state, "created_at": created,
            "html_url": f"https://github.com/x/y/issues/{number}",
            "body": body or (f"<!-- goby-cleaners fp={fp} component={component} "
                             f"severity={severity} -->\n\nbody")}


# --- fingerprints --------------------------------------------------------------------


def test_fingerprint_is_stable_across_a_directory_move_and_noisy_titles():
    a = pf.fingerprint(COMPONENT, finding())
    b = pf.fingerprint(COMPONENT, finding(
        file="services/other/registry.py", title="Slot over-admitted!"))
    assert a == b


def test_fingerprint_separates_components_and_files():
    fp = pf.fingerprint(COMPONENT, finding())
    assert fp != pf.fingerprint("services/billing", finding())
    assert fp != pf.fingerprint(COMPONENT, finding(file="pricing.py"))


def test_marker_round_trips():
    fp = pf.fingerprint(COMPONENT, finding())
    m = pf.parse_marker(pf.marker(COMPONENT, finding(), fp, "high"))
    assert m and m.group("fp") == fp
    assert m.group("component") == COMPONENT and m.group("severity") == "high"


def test_a_legacy_marker_still_counts_as_filed():
    """The two producers ran side by side while the private path was still live, and their
    markers were written by different code. Parsing only our own prefix made every legacy
    issue invisible: no fingerprint, no daily budget, and the same defect filed again."""
    fp = pf.fingerprint(COMPONENT, finding())
    legacy = [issue(fp, body=f"<!-- other-producer fp={fp} component={COMPONENT} "
                             f"severity=medium -->")
              for _ in range(1)]
    filed, skipped = pf.decide([finding()], legacy, issues_per_day=5, now=NOW)
    assert not filed and skipped[0]["reason"] == "already filed"


def test_a_legacy_issue_spends_the_daily_budget():
    """Budget is counted from the label, whatever wrote the marker, or a legacy-heavy day
    lets a fresh producer file its full allowance on top."""
    fp = pf.fingerprint(COMPONENT, finding(title="other defect"))
    legacy = [issue(fp, body=f"<!-- other-producer fp={fp} component={COMPONENT} "
                             f"severity=medium -->")]
    _, skipped = pf.decide([finding(title="new defect")], legacy, issues_per_day=1, now=NOW)
    assert skipped[0]["reason"] == "daily budget spent"


def test_a_body_without_a_marker_is_not_counted():
    assert pf.parse_marker("no marker here") is None


# --- dedupe and budget ---------------------------------------------------------------


def test_a_finding_already_filed_is_not_filed_again():
    f = finding()
    filed, skipped = pf.decide([f], [issue(pf.fingerprint(COMPONENT, f))],
                               issues_per_day=2, now=NOW)
    assert filed == [] and skipped[0]["reason"] == "already filed"


def test_a_closed_issue_still_suppresses_the_finding():
    """Closed as not-a-bug is the answer we do not want to be asked again next week."""
    f = finding()
    filed, _ = pf.decide([f], [issue(pf.fingerprint(COMPONENT, f), state="closed")],
                         issues_per_day=2, now=NOW)
    assert filed == []


def test_a_duplicate_in_the_batch_does_not_starve_the_new_finding():
    """Re-scanning re-reports yesterday's finding first; that duplicate must not spend the
    day's second slot, or a genuinely new defect waits another day."""
    old = finding(title="old defect")
    new = finding(title="new defect")
    existing = [issue(pf.fingerprint(COMPONENT, old), days_ago=0)]
    filed, skipped = pf.decide([old, new], existing, issues_per_day=2, now=NOW)
    assert [i["finding"]["title"] for i in filed] == ["new defect"]
    assert skipped[0]["reason"] == "already filed"


def test_two_identical_findings_in_one_batch_file_once():
    filed, skipped = pf.decide([finding(), finding()], [], issues_per_day=5, now=NOW)
    assert len(filed) == 1 and skipped[0]["reason"] == "duplicate in this run"


def test_a_repeated_repro_later_in_the_batch_is_still_a_duplicate():
    """Only the first repro per fingerprint was remembered, so r1, r2, r2 filed r2 twice: the
    third compared itself against r1, looked new, and became a second issue for one defect."""
    first = finding(repro_command="repro-1")
    second = finding(repro_command="repro-2")
    third = finding(repro_command="repro-2")
    filed, skipped = pf.decide([first, second, third], [], issues_per_day=5, now=NOW)
    assert [i["finding"]["repro_command"] for i in filed] == ["repro-1", "repro-2"]
    assert [s["reason"] for s in skipped] == ["duplicate in this run"]


def test_two_defects_sharing_a_title_both_file():
    """The key is component + file + title, so two defects in one file can collide. Inside a
    run they are two claims by the same agent, and the reproducer is what tells them apart:
    dropping the second one loses its evidence, which is the worse error."""
    on_cancel = finding(title="slot leaked", repro_command="python3 /tmp/r_cancel.py")
    on_timeout = finding(title="slot leaked", repro_command="python3 /tmp/r_timeout.py")
    filed, skipped = pf.decide([on_cancel, on_timeout], [], issues_per_day=5, now=NOW)
    assert [f["finding"]["repro_command"] for f in filed] == [
        "python3 /tmp/r_cancel.py", "python3 /tmp/r_timeout.py"]
    assert skipped == []


def test_a_fingerprint_already_filed_suppresses_both_collisions():
    """History wins over the batch rule: once the defect is on an issue, a second phrasing
    with a new reproducer is still the same defect."""
    first = finding(title="slot leaked", repro_command="python3 /tmp/r1.py")
    second = finding(title="slot leaked", repro_command="python3 /tmp/r2.py")
    existing = [issue(pf.fingerprint(COMPONENT, first))]
    filed, skipped = pf.decide([first, second], existing, issues_per_day=5, now=NOW)
    assert filed == []
    assert {s["reason"] for s in skipped} == {"already filed"}


def test_a_budget_skip_is_labelled_budget_not_duplicate():
    """When the cap holds a finding back, a second finding with the same key and a different
    reproducer is held back by the cap too — it must not be reported as a duplicate of one
    that was never filed."""
    first = finding(title="slot leaked", repro_command="python3 /tmp/r1.py")
    second = finding(title="slot leaked", repro_command="python3 /tmp/r2.py")
    filed, skipped = pf.decide([first, second], [], issues_per_day=0, now=NOW)
    assert filed == []
    assert [s["reason"] for s in skipped] == ["daily budget spent", "daily budget spent"]


def test_a_cap_does_not_hide_a_second_defect_when_room_appears():
    """With room for two, two distinct reproducers are two issues."""
    first = finding(title="slot leaked", repro_command="python3 /tmp/r1.py")
    second = finding(title="slot leaked", repro_command="python3 /tmp/r2.py")
    filed, _ = pf.decide([first, second], [], issues_per_day=2, now=NOW)
    assert len(filed) == 2


def test_a_capped_medium_does_not_swallow_its_high_severity_match():
    """`high` is exempt from the cap, so a budget-skipped medium must not make the high one
    look like a duplicate of something nobody was handed."""
    medium = finding(title="slot leaked", severity="medium")
    high = finding(title="slot leaked", severity="high")
    filed, skipped = pf.decide([medium, high], [], issues_per_day=0, now=NOW)
    assert [f["severity"] for f in filed] == ["high"]
    assert skipped[0]["reason"] == "daily budget spent"


def test_the_daily_cap_counts_other_components():
    other = [issue("eeeeeeeeeeee", component="services/billing", days_ago=0)]
    filed, skipped = pf.decide([finding(title="brand new")], other, issues_per_day=1, now=NOW)
    assert filed == [] and skipped[0]["reason"] == "daily budget spent"


def test_high_severity_is_exempt_from_the_daily_cap():
    other = [issue("aaaaaaaaaaaa", component="elsewhere", severity="medium", days_ago=0)]
    filed, _ = pf.decide([finding(severity="high")], other, issues_per_day=1, now=NOW)
    assert len(filed) == 1, "the cap bounds noise; it must not bury the high one"


def test_high_severity_already_filed_today_does_not_spend_a_slot():
    other = [issue("bbbbbbbbbbbb", component="elsewhere", severity="high", days_ago=0)]
    filed, _ = pf.decide([finding(title="brand new")], other, issues_per_day=1, now=NOW)
    assert len(filed) == 1


def test_yesterday_does_not_spend_todays_slot():
    other = [issue("cccccccccccc", component="elsewhere", days_ago=2)]
    filed, skipped = pf.decide([finding(title="new")], other, issues_per_day=1, now=NOW)
    assert len(filed) == 1, skipped


def test_the_cap_is_per_day_not_per_component():
    """Three findings from one component on a quiet day are three things to read; the only
    ceiling is the day's."""
    filed, _ = pf.decide([finding(title=f"defect {n}") for n in range(3)], [],
                         issues_per_day=5, now=NOW)
    assert len(filed) == 3


# --- rendering ----------------------------------------------------------------------


def test_issue_carries_both_runs_and_the_marker():
    f = finding()
    item = {"fingerprint": pf.fingerprint(COMPONENT, f), "finding": f, "severity": "high"}
    title, body = pf.render_issue(COMPONENT, item, "a" * 40)
    assert title == "[goby-cleaners] api: slot over-admitted"
    assert "python3 /tmp/sandbox/repro1.py" in body
    assert "(2, None, 2)" in body, "the flip run is the evidence the line is the cause"
    assert pf.parse_marker(body).group("severity") == "high"
    assert f"{COMPONENT}/INVARIANTS.md" in body, "the close instruction must name the brief"


# --- filing against a stubbed API ---------------------------------------------------


class FakeGitHub:
    def __init__(self, existing=(), create_status=201):
        self.created, self.labels = [], []
        self.existing = list(existing)
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


def test_one_issue_per_finding_and_no_assignee(monkeypatch):
    gh = FakeGitHub()
    monkeypatch.setattr(pf, "_http", gh)
    items = [{"fingerprint": "d" * 12, "finding": finding(title="a"), "severity": "medium"},
             {"fingerprint": "e" * 12, "finding": finding(title="b"), "severity": "high"}]
    urls, failures = pf.file_findings("o/r", "tok", "c" * 40, items)
    assert failures == [] and len(urls) == 2
    assert [c["labels"] for c in gh.created] == [["goby-cleaners"], ["goby-cleaners"]]
    assert all("assignees" not in c for c in gh.created), "humans route issues"


def test_a_rejected_filing_fails_the_task(monkeypatch, tmp_path, capsys):
    """A reproduced finding that GitHub refused must not end in a green task."""
    monkeypatch.setattr(pf, "_http", FakeGitHub(create_status=403))
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    findings = tmp_path / "findings.jsonl"
    findings.write_text(json.dumps(finding()) + "\n")
    rc = pf.main(["--findings", str(findings), "--repo", "o/r", "--sha", "a" * 40])
    assert rc == 1
    plan = json.loads(capsys.readouterr().out)
    assert plan["failures"] and "403" in plan["failures"][0]


def test_a_failed_listing_files_nothing(monkeypatch, tmp_path):
    """An empty list and a failed read mean opposite things; treating them alike re-files
    everything already open."""
    monkeypatch.setattr(pf, "_http",
                        lambda method, path, token, payload=None: (502, "bad gateway"))
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    findings = tmp_path / "findings.jsonl"
    findings.write_text(json.dumps(finding()) + "\n")
    assert pf.main(["--findings", str(findings), "--repo", "o/r", "--sha", "a" * 40]) == 1


def test_a_scan_with_no_findings_touches_nothing(tmp_path, monkeypatch, capsys):
    called = []
    monkeypatch.setattr(pf, "_http", lambda *a, **k: called.append(a))
    findings = tmp_path / "findings.jsonl"
    findings.write_text("")
    rc = pf.main(["--findings", str(findings), "--repo", "o/r", "--sha", "a" * 40])
    assert rc == 0 and called == []
    assert json.loads(capsys.readouterr().out)["findings"] == 0


def test_dry_run_writes_a_plan_and_never_posts(tmp_path, monkeypatch):
    called = []
    monkeypatch.setattr(pf, "_http", lambda *a, **k: called.append(a))
    findings = tmp_path / "findings.jsonl"
    findings.write_text(json.dumps(finding()) + "\n")
    out = tmp_path / "plan.json"
    rc = pf.main(["--findings", str(findings), "--repo", "o/r", "--sha", "a" * 40,
                  "--out", str(out)])
    assert rc == 0 and called == []
    assert json.loads(out.read_text())["filed"][0]["component"] == COMPONENT


def test_a_finding_without_a_component_is_a_wiring_error(tmp_path, capsys):
    """The component decides the fingerprint and the title; guessing it would file a defect
    under the wrong component."""
    findings = tmp_path / "findings.jsonl"
    findings.write_text(json.dumps(finding(component="")) + "\n")
    rc = pf.main(["--findings", str(findings), "--repo", "o/r", "--sha", "a" * 40,
                  "--dry-run"])
    assert rc == 2
    assert "without a component" in capsys.readouterr().err


def test_a_bare_repo_name_is_normalized_before_lookup(monkeypatch, tmp_path):
    """Dedupe reads and filing writes must address the same repository, or every scan looks
    like the first one."""
    seen = []
    gh = FakeGitHub()

    def fake(method, path, token, payload=None):
        seen.append(path)
        return gh(method, path, token, payload)

    monkeypatch.setattr(pf, "_http", fake)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    findings = tmp_path / "findings.jsonl"
    findings.write_text(json.dumps(finding()) + "\n")
    assert pf.main(["--findings", str(findings), "--repo", "acme/widgets", "--sha", "a" * 40]) == 0
    assert all(p.startswith("/repos/acme/widgets") for p in seen), seen


# --- the run summary and the model-error signal -------------------------------------


def test_the_run_summary_is_one_line_and_never_the_raw_events(tmp_path):
    """A clean scan is silent, so this line is the only evidence it ran — and the last raw
    event carries the whole conversation, system prompt included."""
    events = {
        "type": "message_end",
        "message": {"role": "assistant", "stopReason": "endTurn",
                    "content": [{"type": "text", "text": "Filing nothing.  Clean run."}]},
    }
    path = tmp_path / "events.jsonl"
    path.write_text('{"type":"turn_start"}\n'
                    '{"type":"tool_execution_start","toolName":"read"}\n'
                    + json.dumps(events) + "\n")
    out = subprocess.run([sys.executable, str(HERE / "summarize_run.py"), str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out.startswith("summary: turns=1 tools=1 stop=endTurn")
    assert "Filing nothing. Clean run." in out
    assert len(out.splitlines()) == 1


def test_a_final_turn_without_text_does_not_inherit_the_previous_one(tmp_path):
    path = tmp_path / "events.jsonl"
    earlier = {"type": "message_end", "message": {"role": "assistant", "stopReason": "toolUse",
               "content": [{"type": "text", "text": "looking at registry.py"}]}}
    final = {"type": "message_end", "message": {"role": "assistant", "stopReason": "endTurn",
             "content": []}}
    path.write_text(json.dumps(earlier) + "\n" + json.dumps(final) + "\n")
    out = subprocess.run([sys.executable, str(HERE / "summarize_run.py"), str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    assert "stop=endTurn" in out
    assert "looking at registry.py" not in out


def _events(tmp_path, stop_reason, error=None):
    msg = {"role": "assistant", "stopReason": stop_reason,
           "content": [{"type": "text", "text": "done"}]}
    if error:
        msg["errorMessage"] = error
    path = tmp_path / "events.jsonl"
    path.write_text(json.dumps({"type": "message_end", "message": msg}) + "\n")
    return path


def test_a_failed_model_call_is_a_failure_not_a_clean_run(tmp_path):
    """pi in `--mode json` exits 0 when the model call fails, so silence is otherwise
    indistinguishable from "no bugs"."""
    path = _events(tmp_path, "error",
                   'AI_APICallError: {"error": {"code": "insufficient_credits"}}')
    out = subprocess.run([sys.executable, str(HERE / "summarize_run.py"), "--status",
                          str(path)], capture_output=True, text=True)
    assert out.returncode == 3
    assert "insufficient_credits" in out.stdout


def test_a_completed_turn_passes_the_status_check(tmp_path):
    path = _events(tmp_path, "endTurn")
    out = subprocess.run([sys.executable, str(HERE / "summarize_run.py"), "--status",
                          str(path)], capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout == ""


def test_no_event_stream_is_not_a_model_error(tmp_path):
    out = subprocess.run([sys.executable, str(HERE / "summarize_run.py"), "--status",
                          str(tmp_path / "missing.jsonl")], capture_output=True, text=True)
    assert out.returncode == 0


# --- the dedupe read has to reach the oldest issues -------------------------------


def labelled_issues(count: int) -> list[dict]:
    """Newest first, as GitHub returns them. Issue 1 is the oldest and closed as not-a-bug."""
    return [{"number": n, "state": "closed" if n == 1 else "open",
             "created_at": "2026-01-01T00:00:00Z",
             "body": f"<!-- goby-cleaners fp={n:012x} component=x severity=medium -->"}
            for n in range(count, 0, -1)]


def serve(state: dict):
    def fake(method, path, token, payload=None):
        page = int(path.rsplit("page=", 1)[1])
        state["requested"].append(page)
        return 200, state["issues"][(page - 1) * 100: page * 100]
    return fake


def test_the_dedupe_read_reaches_issues_past_three_pages(monkeypatch):
    """#1296: with 349 labelled issues the read stopped at page 3, so the oldest — a closed
    "not a bug" — was invisible and the same defect was filed again."""
    state = {"issues": labelled_issues(349), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    got = pf.list_labelled("o/r", "tok")
    assert got is not None and len(got) == 349
    assert state["requested"] == [1, 2, 3, 4]
    assert any(i["number"] == 1 for i in got), "the oldest verdict must be in the read"


def test_an_exactly_full_last_page_is_not_mistaken_for_the_end(monkeypatch):
    """350 issues end mid-page; 400 fill four pages exactly, which needs one more request to
    prove there is nothing after them."""
    state = {"issues": labelled_issues(350), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    assert len(pf.list_labelled("o/r", "tok")) == 350
    assert state["requested"] == [1, 2, 3, 4]

    state = {"issues": labelled_issues(400), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    assert len(pf.list_labelled("o/r", "tok")) == 400
    assert state["requested"] == [1, 2, 3, 4, 5]


def test_any_complete_list_is_read_whatever_its_size(monkeypatch):
    """#1298: with the bound expressed in *issues*, 2099 read cleanly and 2100 refused, though
    both lists are complete. In pages there is no such cliff."""
    for count in (2000, 2099, 2100, 2101, 4000):
        state = {"issues": labelled_issues(count), "requested": []}
        monkeypatch.setattr(pf, "_http", serve(state))
        got = pf.list_labelled("o/r", "tok")
        assert got is not None and len(got) == count, count
        if count % 100 == 0:
            # a full final page is proven empty by the request after it
            assert state["requested"][-1] == count // 100 + 1, count


def test_a_history_ending_exactly_at_the_page_bound_is_complete(monkeypatch):
    """100 full pages is 10 000 issues, and page 101 is the request that proves the end.
    Without that probe the bound itself refuses a complete read."""
    state = {"issues": labelled_issues(pf.MAX_LABELLED_PAGES * 100), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    got = pf.list_labelled("o/r", "tok")
    assert got is not None and len(got) == pf.MAX_LABELLED_PAGES * 100
    assert state["requested"][-1] == pf.MAX_LABELLED_PAGES + 1


def test_one_issue_past_the_page_bound_is_refused(monkeypatch):
    state = {"issues": labelled_issues(pf.MAX_LABELLED_PAGES * 100 + 1), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    assert pf.list_labelled("o/r", "tok") is None


def test_walking_past_the_page_bound_fails_loudly(monkeypatch):
    """Nothing is filed from an incomplete read: a prefix of the history re-files defects a
    human already closed."""
    state = {"issues": labelled_issues(250), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    assert pf.list_labelled("o/r", "tok", max_pages=2) is None, "the probe finds more issues"

    state = {"issues": labelled_issues(200), "requested": []}
    monkeypatch.setattr(pf, "_http", serve(state))
    assert len(pf.list_labelled("o/r", "tok", max_pages=2)) == 200, "the probe finds the end"


def test_a_failed_listing_still_returns_none(monkeypatch):
    monkeypatch.setattr(pf, "_http", lambda *a, **k: (502, "bad gateway"))
    assert pf.list_labelled("o/r", "tok") is None


def test_the_page_bound_covers_a_year_of_filings():
    """At the shipped cap: the bound must not be the thing that stops dedupe working. 25/day is
    the image default in `defaults.env`, so that is the rate the read has to outlive."""
    assert pf.MAX_LABELLED_PAGES * 100 >= 25 * 365, "less than a year of filings would be unsafe"


def test_the_label_can_be_overridden_for_a_transition(monkeypatch):
    """Two producers of the same findings must share one label, or neither sees the other's
    issues and the same defect is filed twice while both run."""
    monkeypatch.setenv("CLEANERS_LABEL", "custom-label")
    assert pf.issue_label() == "custom-label"
    monkeypatch.delenv("CLEANERS_LABEL")
    assert pf.issue_label() == pf.LABEL == "goby-cleaners"


def test_the_marker_parses_back_whatever_label_is_in_use(monkeypatch):
    """A scoped label such as `cleaners/goby` is a normal GitHub label, and writing it into the
    marker produced a body the marker grammar rejects — so the issue a run had just filed was
    invisible to the next run's dedupe, which filed it again."""
    for label in ("goby-cleaners", "cleaners/goby", "cleaners:goby", "team cleaners"):
        monkeypatch.setenv("CLEANERS_LABEL", label)
        fp = pf.fingerprint(COMPONENT, finding())
        body = pf.marker(COMPONENT, finding(), fp, "medium")
        parsed = pf.parse_marker(body)
        assert parsed is not None, (label, body)
        assert parsed.group("fp") == fp


def test_the_close_instruction_names_the_brief_that_component_really_has(monkeypatch):
    """The entrypoint records the brief filename per component, so an issue tells a maintainer
    which file carries the invariants and known non-findings."""
    f = finding()
    item = {"fingerprint": pf.fingerprint("services/api", f), "finding": f, "severity": "low"}
    monkeypatch.setattr(pf, "BRIEFS", {"services/api": "INVARIANTS.md"}, raising=False)
    _, body = pf.render_issue("services/api", item, "a" * 40)
    assert "`services/api/INVARIANTS.md`" in body


def test_a_component_with_a_space_round_trips_through_the_marker():
    """#43/#40: a component directory may contain a space. The marker is the only record of what
    is filed, so a marker the grammar cannot read re-files the same defect on every scan."""
    component = "services/api v2"
    fp = pf.fingerprint(component, finding(component=component))
    parsed = pf.parse_marker(pf.marker(component, finding(), fp, "medium"))
    assert parsed is not None, pf.marker(component, finding(), fp, "medium")
    assert parsed.group("component") == component
    assert parsed.group("fp") == fp


def test_a_component_with_a_space_dedupes_against_its_own_issue():
    component = "services/api v2"
    f = finding(component=component)
    fp = pf.fingerprint(component, f)
    filed, skipped = pf.decide([f], [issue(fp, component=component)], issues_per_day=5, now=NOW)
    assert not filed and skipped[0]["reason"] == "already filed"


def test_a_label_with_a_space_is_encoded_into_the_dedupe_read(monkeypatch):
    """#42/#47: `?labels=team cleaners` is not a request line, so the read failed and nothing at
    all was filed under that label."""
    from urllib.parse import parse_qs, urlparse

    seen: list[str] = []

    def fake(method, path, token, payload=None):
        seen.append(path)
        return 200, []

    monkeypatch.setattr(pf, "_http", fake)
    monkeypatch.setenv("CLEANERS_LABEL", "team cleaners")
    assert pf.list_labelled("o/r", "tok") == []
    assert " " not in seen[0]
    assert parse_qs(urlparse(seen[0]).query)["labels"] == ["team cleaners"]


def test_the_page_probe_encodes_the_label_too(monkeypatch):
    """The read past the page bound builds its own URL; an unencoded label there fails the read
    that proves a long history is complete."""
    from urllib.parse import parse_qs, urlparse

    seen: list[str] = []

    def fake(method, path, token, payload=None):
        seen.append(path)
        page = int(parse_qs(urlparse(path).query)["page"][0])
        return 200, labelled_issues(200)[(page - 1) * 100: page * 100]

    monkeypatch.setattr(pf, "_http", fake)
    monkeypatch.setenv("CLEANERS_LABEL", "team cleaners")
    assert len(pf.list_labelled("o/r", "tok", max_pages=2) or []) == 200
    assert all(" " not in path for path in seen)


def test_a_component_that_looks_like_the_marker_does_not_set_the_severity():
    """A directory name may end in ` severity=high -->`, which closed the marker early and made a
    medium finding exempt from `issues_per_day`. The component runs to the last delimiter."""
    component = "svc severity=high -->"
    fp = pf.fingerprint(component, finding(component=component))
    parsed = pf.parse_marker(pf.marker(component, finding(), fp, "medium"))
    assert parsed is not None
    assert parsed.group("component") == component
    assert parsed.group("severity") == "medium"


def test_a_marker_quoted_inside_a_body_is_not_a_filing():
    """The repro output of a scan of this repository is full of markers. Reading them as filings
    suppressed the real finding one of them named, and spent the budget it needed."""
    real = finding(title="the real one")
    fp = pf.fingerprint(COMPONENT, real)
    quoted = issue("0" * 12, body="**Reproduced with:**\n\n```\n"
                    + pf.marker(COMPONENT, real, fp, "medium") + "\n```\n")

    filed, skipped = pf.decide([real], [quoted], issues_per_day=1, now=NOW)
    assert [f["fingerprint"] for f in filed] == [fp]
    assert not skipped, "a quoted marker must neither suppress the finding nor spend the budget"

    filed, _ = pf.decide([finding(title="brand new")], [quoted], issues_per_day=1, now=NOW)
    assert filed, "the quoted medium must not count against the day's allowance"


def test_a_title_in_another_script_keeps_its_own_fingerprint():
    """`[^a-z0-9 ]` erased every non-Latin title to "", so two different defects in one file
    shared a fingerprint and the second was filed as "already filed" forever."""
    first = finding(title="缓存没有失效")
    second = finding(title="异常被吞掉")
    assert pf._norm(first["title"]) != pf._norm(second["title"])
    assert pf.fingerprint(COMPONENT, first) != pf.fingerprint(COMPONENT, second)

    filed, skipped = pf.decide([second], [issue(pf.fingerprint(COMPONENT, first))],
                               issues_per_day=25, now=NOW)
    assert filed and not skipped


def test_ascii_normalisation_still_collides_where_it_should():
    """The fingerprint's job is unchanged: case, punctuation and spacing do not make a new claim."""
    assert pf.fingerprint(COMPONENT, finding(title="Slot over-admitted")) == \
        pf.fingerprint(COMPONENT, finding(title="slot over admitted"))
    assert pf.fingerprint(COMPONENT, finding(title="100% broken_loop!")) == \
        pf.fingerprint(COMPONENT, finding(title="100 broken loop"))


def test_an_accented_title_keeps_the_fingerprint_it_was_filed_under():
    """Dedupe history *is* the fingerprint. The Unicode form must only be a fallback for a title
    with no ASCII letters at all, or every issue filed under an accented title is re-filed."""
    import hashlib

    title = "Falha na validação do cache"
    legacy = " ".join(re.sub(r"[^a-z0-9 ]+", " ", title.lower()).split())
    assert pf._norm(title) == legacy

    fp_old = hashlib.sha256("|".join([COMPONENT, "registry.py", legacy]).encode()).hexdigest()[:12]
    filed, skipped = pf.decide([finding(title=title)], [issue(fp_old)], issues_per_day=25, now=NOW)
    assert not filed and skipped[0]["reason"] == "already filed"
