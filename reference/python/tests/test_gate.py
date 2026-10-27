"""Gate regressions: canned model output and GitHub transport, never network."""
import itertools
import json
import os
import re
import subprocess
import textwrap
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from goby import cli
from goby.core import gate, review
from goby.core.verdict import ReviewReceipt, evaluate_gate, gate_allowed, parse_receipt
from goby.identity import GATE_CONTEXT
from goby.platforms import github, publish

HEAD = "a" * 40
OTHER = "b" * 40
DIFF = "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1 +1 @@\n-return total\n+return total - 1\n"
FIELDS = ("receipt_valid", "same_head", "complete", "agent", "no_unthreaded",
          "threads_complete", "findings_accounted", "no_open_threads", "execution_succeeded")


def receipt(**kwargs):
    return replace(ReviewReceipt(HEAD, True, True, 0, ()), **kwargs)


def finding(severity="high", line=1):
    return {"path": "calc.py", "line": line, "severity": severity,
            "title": "Wrong result", "detail": "The result is reduced by one for every input."}


@pytest.mark.parametrize("values", list(itertools.product((False, True), repeat=9)))
def test_policy_exhaustive(values):
    assert gate_allowed(**dict(zip(FIELDS, values))) is all(values)


def test_unknown_is_not_permission():
    for key in FIELDS:
        facts = dict.fromkeys(FIELDS, True)
        facts[key] = 1
        assert gate_allowed(**facts) is False


def test_receipt_roundtrip():
    r = receipt(finding_ids=("abcd1234",))
    assert parse_receipt(r.marker(), HEAD) == r


@pytest.mark.parametrize("change", [
    {"schema": 2}, {"schema": True}, {"complete": 1}, {"agent": "true"},
    {"head_sha": OTHER}, {"head_sha": HEAD[:10]}, {"unthreaded": -1},
    {"unthreaded": False}, {"finding_ids": ["x"]},
    {"finding_ids": ["aa", "aa"]}, {"finding_ids": "aa"}, {"extra": 1},
])
def test_malformed_receipt_is_not_permission(change):
    data = {**asdict(receipt()), **change}
    marker = "<!-- goby-gate " + json.dumps(data) + " -->"
    assert parse_receipt(marker, HEAD) is None


def test_duplicate_receipt_is_ambiguous():
    assert parse_receipt(receipt().marker() + "\n" + receipt().marker(), HEAD) is None
    assert parse_receipt("[]", HEAD) is None


@pytest.mark.parametrize("r,opened,resolved,complete", [
    (None, [], [], True),
    (receipt(head_sha=OTHER), [], [], True),
    (receipt(complete=False), [], [], True),
    (receipt(agent=False), [], [], True),
    (receipt(unthreaded=1), [], [], True),
    (receipt(), [], [], False),
    (receipt(finding_ids=("aa",)), [], [], True),
    (receipt(), [{"fid": "old", "sha": OTHER[:10]}], [], True),
    (receipt(finding_ids=("aa",)), [], [{"fid": "aa", "sha": OTHER[:10]}], True),
])
def test_each_missing_fact_blocks(r, opened, resolved, complete):
    assert not evaluate_gate(r, HEAD, opened, resolved, complete).allowed


def test_resolved_findings_pass_but_deleted_threads_do_not():
    r = receipt(finding_ids=("aa",))
    assert evaluate_gate(r, HEAD, [], [{"fid": "aa", "sha": HEAD[:10]}], True,
                         execution_succeeded=True).allowed
    assert not evaluate_gate(r, HEAD, [], [], True).allowed


def review_row(r=None, **changes):
    return {"id": 1, "user": {"login": "github-actions[bot]"}, "commit_id": HEAD,
            "state": "COMMENTED", "body": "**Goby Review** — agentic review\n\n" +
            (r or receipt()).marker(), **changes}


@pytest.mark.parametrize("change", [
    {"user": {"login": "contributor"}}, {"commit_id": OTHER},
    {"state": "PENDING"}, {"state": "DISMISSED"}, {"body": receipt().marker()},
])
def test_receipt_loader_requires_trusted_envelope(monkeypatch, change):
    monkeypatch.setattr(github, "gh_get", lambda *a: json.dumps([review_row(**change)]))
    assert gate.load_receipt("t", "o/r", 1, HEAD) is None


def test_latest_invalid_review_cannot_resurrect_old_green(monkeypatch):
    rows = [review_row(), review_row(id=2, body="**Goby Review** — no receipt")]
    monkeypatch.setattr(github, "gh_get", lambda *a: json.dumps(rows))
    assert gate.load_receipt("t", "o/r", 1, HEAD) is None


def test_review_pagination_must_finish(monkeypatch):
    calls = []
    def get(path, *args):
        calls.append(path)
        return json.dumps([review_row()] * 100)
    monkeypatch.setattr(github, "gh_get", get)
    with pytest.raises(RuntimeError, match="pagination cap"):
        gate.load_receipt("t", "o/r", 1, HEAD)
    assert len(calls) == 20


@pytest.mark.parametrize("data", [
    {}, {"data": None}, {"data": {"repository": None}},
    {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}},
    {"data": {"repository": {"pullRequest": {"reviewThreads": {
        "nodes": [], "pageInfo": {"hasNextPage": "false"}}}}}},
])
def test_unknown_thread_data_is_not_complete(monkeypatch, data):
    monkeypatch.setattr(github, "gh_graphql", lambda *a: data)
    assert github.fetch_thread_state("t", "o/r", 1)[2] is False


@pytest.fixture
def harness(monkeypatch):
    """Exercise review.main and the real publisher and gate; mock only I/O."""
    h = SimpleNamespace(rows=[], threads=[], statuses=[], model_calls=0,
                        content="[]", exhausted=False, truncated=False,
                        head=HEAD, fallback=False, thread_complete=True)
    monkeypatch.setattr(github, "fetch_pr_meta", lambda *a: {"head_sha": h.head})
    monkeypatch.setattr(github, "fetch_diff", lambda *a: DIFF)
    monkeypatch.setattr(github, "fetch_repo_context", lambda *a: "")
    monkeypatch.setattr(github, "fetch_pr_intent", lambda *a: {})
    monkeypatch.setattr(github, "fetch_open_own_threads", lambda *a: [t for t in h.threads if not t["resolved"]])
    monkeypatch.setattr(github, "fetch_resolved_own_threads", lambda *a: [t for t in h.threads if t["resolved"]])
    monkeypatch.setattr(github, "fetch_thread_state", lambda *a: (
        [t for t in h.threads if not t["resolved"]],
        [t for t in h.threads if t["resolved"]], h.thread_complete))
    monkeypatch.setattr(github, "latest_status_state", lambda *a: "success")
    monkeypatch.setattr(review, "resolve_api_key", lambda *a: "fake")
    monkeypatch.setattr(review, "resolve_own_threads", lambda *a: 0)
    monkeypatch.setattr(review, "minimize_resolved_rounds", lambda *a: 0)
    def model(**kwargs):
        h.model_calls += 1
        return SimpleNamespace(content=h.content, elapsed_s=0.1, prompt_tokens=100,
                               completion_tokens=20, turns=1, tool_calls=0,
                               tool_counts={}, budget_exhausted=h.exhausted,
                               final_truncated=h.truncated)
    monkeypatch.setattr(review.agent_mod, "run_agent_review", model)
    monkeypatch.setattr(review, "call_model", model)
    def get(path, *args):
        assert "/reviews?" in path
        return json.dumps(h.rows)
    monkeypatch.setattr(github, "gh_get", get)
    def post(path, token, payload):
        if "/statuses/" in path:
            h.statuses.append(payload)
            return payload
        assert path.endswith("/reviews")
        if h.fallback and payload["comments"]:
            raise github.GitHubError(422, path, "invalid line")
        row = review_row(id=len(h.rows)+1, body=payload["body"], commit_id=payload["commit_id"])
        h.rows.append(row)
        for comment in payload["comments"]:
            fid = re.search(r"id=(\w+)", comment["body"])[1]
            h.threads.append({"fid": fid, "sha": HEAD[:10], "resolved": False,
                              "path": "calc.py", "line": 1, "title": "Wrong result",
                              "outdated": False, "created_at": "2026-01-01"})
        return row
    monkeypatch.setattr(publish, "gh_post", post)
    h.run = lambda *extra: review.main(["--pr", "1", "--repo", "o/r", "--token", "fake",
                                       "--agent", "--fail-on-blocked", *extra])
    return h


def last_gate(h):
    return [s for s in h.statuses if s["context"] == GATE_CONTEXT][-1]["state"]


def test_clean_review_passes(harness):
    assert harness.run() == 0
    assert last_gate(harness) == "success"
    assert harness.statuses[0]["state"] == "pending"
    assert parse_receipt(harness.rows[0]["body"], HEAD).complete


@pytest.mark.parametrize("severity", ["low", "medium", "high"])
def test_any_unresolved_bug_blocks_but_execution_succeeds(harness, severity):
    harness.content = json.dumps([finding(severity)])
    assert harness.run() == 2
    assert last_gate(harness) == "failure"
    assert any(s["context"] == "Goby Review" and s["state"] == "success" for s in harness.statuses)


@pytest.mark.parametrize("flag", ["exhausted", "truncated"])
def test_incomplete_result_blocks_and_reruns(harness, flag):
    setattr(harness, flag, True)
    assert harness.run() == 2
    assert last_gate(harness) == "failure"
    setattr(harness, flag, False)
    assert harness.run() == 0
    assert harness.model_calls == 2


def test_oversized_diff_is_not_a_green_gate(harness):
    assert harness.run("--max-diff-lines", "1") == 2
    assert last_gate(harness) == "failure"
    assert harness.model_calls == 0


@pytest.mark.parametrize("content", [
    '[{}]', json.dumps([finding(), {"line": 1}]),
    '```json\n[]\n```\n```json\n[invalid]\n```',
    '[{"path":"x","line":1e999,"title":"Bad line"}]',
])
def test_malformed_entries_never_become_a_clean_review(harness, content):
    harness.content = content
    assert harness.run() == 1
    assert last_gate(harness) == "error"


@pytest.mark.parametrize("state", ["error", "failure", "pending", None])
def test_old_receipt_cannot_hide_unsuccessful_execution(harness, monkeypatch, state):
    assert harness.run() == 0
    monkeypatch.setattr(github, "latest_status_state", lambda *a: state)
    result = gate.refresh_gate("fake", "o/r", 1, expected_head=HEAD)
    assert not result.allowed
    assert last_gate(harness) == "failure"


def test_unparseable_reply_sets_error_on_both_statuses(harness):
    harness.content = "invalid"
    assert harness.run() == 1
    assert last_gate(harness) == "error"


@pytest.mark.parametrize("kwargs,extra", [
    ({"content": json.dumps([finding(line=100)])}, []),
    ({"content": json.dumps([finding(), finding(line=100)])}, ["--max-findings", "1"]),
    ({"content": json.dumps([finding()]), "fallback": True}, []),
    ({"thread_complete": False}, []),
])
def test_summary_only_missing_or_partial_evidence_blocks(harness, kwargs, extra):
    for key, value in kwargs.items():
        setattr(harness, key, value)
    assert harness.run(*extra) == 2
    assert last_gate(harness) == "failure"


def test_resolution_refreshes_gate_without_model(harness):
    harness.content = json.dumps([finding()])
    assert harness.run() == 2
    harness.threads[0]["resolved"] = True
    assert gate.main(["--pr", "1", "--repo", "o/r", "--token", "fake",
                      "--expected-head", HEAD]) == 0
    assert last_gate(harness) == "success"
    assert harness.model_calls == 1
    assert harness.run() == 0  # duplicate event reuses complete receipt
    assert harness.model_calls == 1


def test_stale_expected_head_never_posts(harness):
    assert harness.run("--expected-head", OTHER) == 1
    assert harness.statuses == []
    assert harness.rows == []


def test_head_moving_after_model_does_not_publish(harness, monkeypatch):
    old = review.agent_mod.run_agent_review
    def move(**kwargs):
        result = old(**kwargs)
        harness.head = OTHER
        return result
    monkeypatch.setattr(review.agent_mod, "run_agent_review", move)
    assert harness.run() == 1
    assert harness.rows == []
    assert not any(s["state"] == "success" for s in harness.statuses)


def test_gate_detects_head_moving_during_reads(harness, monkeypatch):
    assert harness.run() == 0
    harness.statuses.clear()
    def move(*args):
        harness.head = OTHER
        return [], [], True
    monkeypatch.setattr(github, "fetch_thread_state", move)
    assert gate.main(["--pr", "1", "--repo", "o/r", "--token", "fake",
                      "--expected-head", HEAD]) == 1
    assert [s["state"] for s in harness.statuses] == ["pending"]


def test_gate_read_error_clears_old_success(harness, monkeypatch):
    assert harness.run() == 0
    def fail(*args):
        raise github.GitHubError(502, "test", "bad gateway")
    monkeypatch.setattr(github, "fetch_thread_state", fail)
    result = gate.refresh_gate("fake", "o/r", 1, expected_head=HEAD)
    assert result.state == "error"
    assert last_gate(harness) == "error"


def test_dry_run_never_posts(harness):
    assert harness.run("--dry-run") == 0
    assert harness.statuses == harness.rows == []


def test_gate_dry_run_writes_report_without_posting(harness, tmp_path):
    assert harness.run() == 0
    harness.statuses.clear()
    report = tmp_path / "gate.json"
    assert cli.main(["gate", "--pr", "1", "--repo", "o/r", "--token", "fake",
                     "--dry-run", "--output-file", str(report)]) == 0
    assert json.loads(report.read_text())["head_sha"] == HEAD
    assert harness.statuses == []


def test_init_requires_real_pin_and_emits_gate_workflow(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit):
        cli.main(["init"])
    with pytest.raises(SystemExit):
        cli.main(["init", "--ref", "v1"])
    assert cli.main(["init", "--ref", HEAD]) == 0
    text = cli.WORKFLOW_PATH.read_text()
    assert "goby@" + HEAD in text
    assert "cancel-in-progress: true" in text
    assert "head.repo.full_name == github.repository" in text
    assert cli.main(["init", "--ref", HEAD]) == 1


def test_action_runs_its_source_and_quotes_inputs(tmp_path):
    action = Path(__file__).parents[1] / "action.yml"
    source = action.read_text()
    assert "pip install" not in source
    assert "actions/checkout" not in source
    script = textwrap.dedent(source.split("      run: |\n", 1)[1])
    fake_python = tmp_path / "python"
    fake_python.write_text('#!/bin/bash\nprintf "%s\\0" "$@" > "$ARGS_FILE"\nprintf "%s" "$PYTHONPATH" > "$PATH_FILE"\n')
    fake_python.chmod(0o755)
    dangerous = "$(touch SHOULD_NOT_EXIST); model name"
    env = {**os.environ, "PATH": str(tmp_path) + ":" + os.environ["PATH"],
           "ACTION_PATH": str(action.parent), "INPUT_PR": "12", "INPUT_HEAD": HEAD,
           "INPUT_MODE": "review", "INPUT_FAIL": "true", "INPUT_MODEL": dangerous,
           "INPUT_BASE_URL": "", "GOBY_PROVIDER": "coral", "ARGS_FILE": str(tmp_path / "args"),
           "PATH_FILE": str(tmp_path / "path")}
    run = subprocess.run(["bash", "-c", script], cwd=tmp_path, env=env, capture_output=True)
    assert run.returncode == 0, run.stderr
    args = (tmp_path / "args").read_bytes().decode().split("\0")
    assert dangerous in args
    assert "--fail-on-blocked" in args
    assert not (tmp_path / "SHOULD_NOT_EXIST").exists()
    assert (tmp_path / "path").read_text() == str(action.parent / "src")
    for bad in ({"INPUT_PR": "1; true"}, {"INPUT_MODE": "version"}, {"INPUT_FAIL": "maybe"}):
        assert subprocess.run(["bash", "-c", script], cwd=tmp_path,
                              env={**env, **bad}, capture_output=True).returncode == 2
