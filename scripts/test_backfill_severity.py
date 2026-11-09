"""The one-off backfill: what it reads, what it refuses to guess, and what it writes.

No network: `_http` is stubbed, and `plan()` is pure.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_backfill_severity", HERE / "backfill_severity.py")
backfill = importlib.util.module_from_spec(spec)
sys.modules["goby_backfill_severity"] = backfill
spec.loader.exec_module(backfill)


def cleaners_issue(number, severity="medium", state="open", labels=(), title="a defect"):
    """An issue as the API returns it, with the marker the cleaner really wrote."""
    return {"number": number, "state": state, "title": title,
            "labels": [{"name": name} for name in labels],
            "body": f"<!-- goby-cleaners fp={number:012x} component=api severity={severity} -->"
                    f"\n\n**Component:** `api` · **Severity:** {severity}\n"}


def tide_issue(number, labels=(), title="ml/infra: 242 files (limit 30)"):
    """A smell: its marker has no severity field at all, which is what "no severity" means."""
    return {"number": number, "state": "open", "title": title,
            "labels": [{"name": name} for name in labels],
            "body": f"<!-- goby-tide fp={number:012x} check=max_dir_files path=ml/infra -->"
                    "\n\n**Measured:** 242 files — the limit is 30\n"}


class FakeGitHub:
    def __init__(self, listed=()):
        self.calls, self.added, self.labels = [], [], []
        self.listed = list(listed)

    def __call__(self, method, path, token, payload=None):
        self.calls.append((method, path, payload))
        if method == "GET":
            return 200, self.listed
        if "/issues/" in path:
            self.added.append((path, payload["labels"]))
            return 200, []
        self.labels.append(payload["name"])
        return 422, {"message": "already exists"}


# --- what the marker says ------------------------------------------------------------


def test_the_severity_is_the_one_the_marker_records():
    todo, skipped = backfill.plan([cleaners_issue(1, "high"), cleaners_issue(2, "low")])
    assert [(i["number"], i["label"]) for i in todo] == [
        (1, "Severity:high"), (2, "Severity:low")]
    assert skipped == []


def test_a_smell_is_skipped_rather_than_given_a_severity_it_never_had():
    """A tide issue has no severity: the threshold is the filter. `Severity:low` on it would be a
    claim nobody measured, and a filter that mixes the two products' history is worse than none."""
    todo, skipped = backfill.plan([tide_issue(7)])
    assert todo == []
    assert skipped == [{"number": 7, "reason": "no severity in the marker",
                        "title": "ml/infra: 242 files (limit 30)"}]


def test_a_quoted_marker_is_not_a_filing():
    body = cleaners_issue(9)["body"]
    issue = {"number": 9, "title": "quotes a marker", "labels": [],
             "body": "**Reproduced with:**\n\n```\n" + body + "\n```\n"}
    todo, skipped = backfill.plan([issue])
    assert todo == [] and skipped[0]["reason"] == "no severity in the marker"


def test_a_severity_outside_the_vocabulary_is_skipped():
    todo, skipped = backfill.plan([cleaners_issue(3, "critical")])
    assert todo == [] and skipped[0]["reason"] == "no severity in the marker"


# --- idempotency, and the human who got there first ----------------------------------


def test_an_issue_that_already_carries_the_label_is_not_touched():
    todo, skipped = backfill.plan([cleaners_issue(4, "high", labels=["goby-cleaners", "goby",
                                                                     "Severity:high"])])
    assert todo == [] and skipped[0]["reason"] == "already labelled"


def test_a_label_that_disagrees_with_the_marker_is_reported_not_overwritten():
    """Somebody relabelled it by hand. A backfill reading a months-old body is not the thing that
    overrules a person, and the disagreement is the interesting part."""
    todo, skipped = backfill.plan([cleaners_issue(5, "medium", labels=["Severity:high"])])
    assert todo == []
    assert skipped[0]["reason"] == "labelled Severity:high, marker says Severity:medium"


def test_a_similar_label_is_not_mistaken_for_a_severity_label():
    todo, _ = backfill.plan([cleaners_issue(6, "low", labels=["high", "Severity-low"])])
    assert [(i["number"], i["label"]) for i in todo] == [(6, "Severity:low")]


# --- writing -------------------------------------------------------------------------


def test_a_dry_run_reads_and_writes_nothing(monkeypatch, capsys):
    gh = FakeGitHub(listed=[cleaners_issue(1, "high"), tide_issue(2)])
    monkeypatch.setattr(backfill.common, "_http", gh)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    assert backfill.main(["--repo", "o/r"]) == 0
    assert [method for method, _, _ in gh.calls] == ["GET"], "nothing but the read"
    out = capsys.readouterr().out
    assert "1 to label" in out and "1 skipped" in out and "nothing written" in out


def test_apply_creates_the_three_labels_then_adds_one_per_issue(monkeypatch):
    """All three labels, not just the ones this history needs: the point is a filter list that
    does not depend on which severities happen to have been filed."""
    gh = FakeGitHub(listed=[cleaners_issue(1, "high"), cleaners_issue(2, "high"),
                            tide_issue(3), cleaners_issue(4, "low", labels=["Severity:low"])])
    monkeypatch.setattr(backfill.common, "_http", gh)
    listed = backfill.common.list_labelled("o/r", "tok", backfill.GENERAL, state="all")
    todo, skipped = backfill.plan(listed)
    assert backfill.create_labels("o/r", "tok") == [
        "Severity:high", "Severity:medium", "Severity:low"]
    assert backfill.apply("o/r", "tok", todo) == []
    assert gh.added == [("/repos/o/r/issues/1/labels", ["Severity:high"]),
                        ("/repos/o/r/issues/2/labels", ["Severity:high"])]
    assert [s["number"] for s in skipped] == [3, 4]


def test_apply_through_main_writes_only_after_creating_the_labels(monkeypatch, capsys):
    gh = FakeGitHub(listed=[cleaners_issue(1, "medium")])
    monkeypatch.setattr(backfill.common, "_http", gh)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    assert backfill.main(["--repo", "o/r", "--apply", "--json"]) == 0
    paths = [path for _, path, _ in gh.calls]
    assert paths == ["/repos/o/r/issues?labels=goby&state=all&per_page=100&page=1",
                     "/repos/o/r/labels", "/repos/o/r/labels", "/repos/o/r/labels",
                     "/repos/o/r/issues/1/labels"]
    assert json.loads(capsys.readouterr().out)["to_label"][0]["label"] == "Severity:medium"


def test_a_rejected_label_reaches_the_caller(monkeypatch, capsys):
    def fake(method, path, token, payload=None):
        if method == "GET":
            return 200, [cleaners_issue(5, "high")]
        return (422, {}) if path.endswith("/labels") and "/issues/" not in path \
            else (403, "Resource not accessible")

    monkeypatch.setattr(backfill.common, "_http", fake)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    assert backfill.main(["--repo", "o/r", "--apply"]) == 1
    assert "403" in capsys.readouterr().err


def test_an_unreadable_history_labels_nothing(monkeypatch, capsys):
    def fake(method, path, token, payload=None):
        return 502, "bad gateway"

    monkeypatch.setattr(backfill.common, "_http", fake)
    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    assert backfill.main(["--repo", "o/r", "--apply"]) == 1
    assert "nothing labelled" in capsys.readouterr().err


def test_the_repository_is_normalised_the_same_way_every_goby_call_normalises_it():
    assert backfill.common.full_name("www") == "Coral-Bricks-AI/www"
    assert backfill.common.full_name("acme/www") == "acme/www"


def test_the_plan_survives_a_json_round_trip():
    """The plan is what a reader approves before anything is written, so it has to be printable."""
    todo, _ = backfill.plan([cleaners_issue(1, "medium", title="a • unicode title")])
    assert json.loads(json.dumps(todo))[0]["title"] == "a • unicode title"
