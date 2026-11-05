"""Tests for the decisions that used to live in shell: what to scan, and what was found."""
import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_cleaners_plan", HERE / "plan.py")
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


# --- components ----------------------------------------------------------------------


def test_a_component_is_the_directory_holding_the_file():
    found, notes = plan.components(["services/api/INVARIANTS.md",
                                    "cleaners/INVARIANTS.md"])
    assert found == ["cleaners", "services/api"]
    assert notes == []


def test_the_root_cleaner_md_is_named_and_dropped():
    """A root-level INVARIANTS.md means "scan the whole repo", the one scope this design exists to
    avoid — and `sed 's|/INVARIANTS.md$||'` used to leave it as a component called `INVARIANTS.md`."""
    found, notes = plan.components(["INVARIANTS.md", "a/INVARIANTS.md"])
    assert found == ["a"]
    assert notes and "root-level" in notes[0]


def test_a_duplicate_path_yields_one_component():
    found, _ = plan.components(["a/INVARIANTS.md", "a/INVARIANTS.md"])
    assert found == ["a"]


def test_a_file_that_is_not_cleaner_md_is_reported_not_guessed():
    found, notes = plan.components(["a/INVARIANTS.md", "a/README.md", ""])
    assert found == ["a"]
    assert any("a/README.md" in n for n in notes)


# --- picked --------------------------------------------------------------------------


def test_only_components_containing_a_changed_file_are_picked():
    comps = ["services/api", "services/billing"]
    chosen, note = plan.picked(comps, ["services/api/registry.py"], 3, True)
    assert chosen == ["services/api"]
    assert "1/2" in note


def test_a_sibling_with_a_common_prefix_is_not_a_match():
    """`a/bc/x` is not inside `a/b`; a prefix test without the separator would scan it."""
    chosen, _ = plan.picked(["a/b"], ["a/bc/x.py"], 3, True)
    assert chosen == []


def test_a_component_whose_directory_changed_is_picked():
    chosen, _ = plan.picked(["a/b"], ["a/b"], 3, True)
    assert chosen == ["a/b"]


def test_an_unknown_change_set_scans_everything():
    chosen, note = plan.picked(["a", "b"], [], 5, before_known=False)
    assert chosen == ["a", "b"] and "unknown" in note


def test_an_unknown_change_set_is_still_capped():
    chosen, note = plan.picked(["a", "b", "c"], [], 2, before_known=False)
    assert chosen == ["a", "b"] and "capped 3 to 2" in note


def test_the_cap_applies_to_a_known_change_set_too():
    comps = ["a", "b", "c"]
    chosen, note = plan.picked(comps, ["a/x", "b/x", "c/x"], 1, True)
    assert len(chosen) == 1 and "capped 3 to 1" in note


def test_nothing_touched_picks_nothing_rather_than_everything():
    chosen, _ = plan.picked(["a", "b"], ["docs/readme.md"], 3, True)
    assert chosen == []


def test_the_component_with_more_changed_files_is_scanned_first():
    """The cap used to slice the alphabet, so `a` won a push that moved `z` twice as far."""
    chosen, note = plan.picked(["a", "z"], ["a/one.py", "z/one.py", "z/two.py"], 1, True)
    assert chosen == ["z"]
    assert "dropped: a" in note


def test_a_tie_is_stable_for_one_push_and_ignores_the_input_order():
    """One changed file each is the common case. The pick must be reproducible for the same
    commit, and must not depend on the order the component list arrived in."""
    changed = ["a/x.py", "b/x.py"]
    first, _ = plan.picked(["a", "b"], changed, 1, True, sha="abc123")
    again, _ = plan.picked(["a", "b"], changed, 1, True, sha="abc123")
    flipped, _ = plan.picked(["b", "a"], changed, 1, True, sha="abc123")
    assert first == again == flipped
    assert first in (["a"], ["b"])


def test_a_tie_does_not_favour_the_same_component_on_every_push():
    """Alphabetical tie-breaking starves whichever component sorts last, and a key made only of
    the paths would starve it whenever two pushes touch the same ones. The commit is part of
    the key, so the loss rotates."""
    changed = ["a/x.py", "b/x.py"]
    picks = set()
    for n in range(8):
        sha = hashlib.sha1(str(n).encode()).hexdigest()
        chosen, _ = plan.picked(["a", "b"], changed, 1, True, sha=sha)
        picks.add(chosen[0])
    assert picks == {"a", "b"}


def test_two_pushes_over_the_same_paths_can_drop_different_components():
    """The reported case: five one-file components, a cap of four, and the same paths changed
    twice. Both pushes must not drop the same component."""
    comps = ["a", "b", "c", "d", "e"]
    changed = [f"{c}/x.py" for c in comps]
    dropped = set()
    for n in range(8):
        sha = hashlib.sha1(str(n).encode()).hexdigest()
        _, note = plan.picked(comps, changed, 4, True, sha=sha)
        dropped.add(note.split("dropped: ")[1])
    assert len(dropped) > 1


def test_the_default_cap_is_four_wherever_it_is_defaulted(tmp_path):
    """The image owns the default, the picker carries one for direct use, and the workflow only
    passes an override. A half-raised cap scans three on one trigger and four on another, and
    nobody notices until a component is silently never scanned."""
    assert 'MAX_COMPONENTS:=4' in (HERE / "defaults.env").read_text()
    workflow = (HERE.parent / ".github" / "workflows"
                / "cleaners-post-merge.yml").read_text()
    assert 'MAX_COMPONENTS: ${{ inputs.max-components }}' in workflow
    assert '"--max", type=int, default=4' in (HERE / "plan.py").read_text()
    changed = tmp_path / "changed.txt"
    changed.write_text("".join(f"c{n}/x.py\n" for n in range(5)))
    out = subprocess.run(
        [sys.executable, str(HERE / "plan.py"), "picked", "--changed", str(changed)],
        input="".join(f"c{n}/INVARIANTS.md\n" for n in range(5)),
        capture_output=True, text=True)
    assert len(out.stdout.split()) == 4, out.stdout


# --- collect -------------------------------------------------------------------------


def test_every_cleaner_directory_contributes_its_findings(tmp_path):
    """One level under `agent/`: the retry directory (`<slug>-retry`) sits here too, and a
    finding it produced must be filed."""
    agent = tmp_path / "agent"
    for slug, titles in (("dispatch", ["a"]), ("dispatch-retry", ["b", "c"]), ("pricing", [])):
        d = agent / slug
        d.mkdir(parents=True)
        if titles:
            (d / "findings.jsonl").write_text("".join(f'{{"title": "{t}"}}\n' for t in titles))
    out = tmp_path / "findings.jsonl"
    assert plan.collect(agent, out) == 3
    assert [l for l in out.read_text().splitlines() if l] == [
        '{"title": "a"}', '{"title": "b"}', '{"title": "c"}']


def test_no_findings_writes_an_empty_file_and_counts_zero(tmp_path):
    agent = tmp_path / "agent"
    (agent / "dispatch").mkdir(parents=True)
    out = tmp_path / "findings.jsonl"
    assert plan.collect(agent, out) == 0
    assert out.read_text() == ""


def test_a_missing_newline_between_scans_does_not_merge_two_findings(tmp_path):
    agent = tmp_path / "agent"
    for slug in ("a", "b"):
        d = agent / slug
        d.mkdir(parents=True)
        (d / "findings.jsonl").write_text('{"title": "no trailing newline"}')
    out = tmp_path / "findings.jsonl"
    assert plan.collect(agent, out) == 2
    assert len(out.read_text().splitlines()) == 2


# --- the CLI the entrypoint uses -----------------------------------------------------


def test_the_cli_prints_the_picked_components_one_per_line(tmp_path):
    changed = tmp_path / "changed.txt"
    changed.write_text("services/api/registry.py\n")
    out = subprocess.run(
        [sys.executable, str(HERE / "plan.py"), "picked", "--changed", str(changed), "--max", "3"],
        input="services/api/INVARIANTS.md\nservices/billing/INVARIANTS.md\n",
        capture_output=True, text=True)
    assert out.returncode == 0
    assert out.stdout.split() == ["services/api"]
    assert "1/2" in out.stderr


# --- classify ------------------------------------------------------------------------


def test_a_scan_that_worked_is_ok():
    assert plan.classify(0, model_failed=False, findings=0) == "ok"


def test_a_failed_model_call_is_retried_when_it_left_nothing_behind():
    assert plan.classify(0, model_failed=True, findings=0) == "retry"


def test_a_failed_model_call_after_findings_is_filed_not_retried():
    """The findings came through the emit tool, which refuses one without its repro and its
    flip; re-scanning would file them again under reworded titles."""
    assert plan.classify(0, model_failed=True, findings=2) == "warn"


def test_cleaner_sh_refusals_are_wiring_and_never_retried():
    """`cleaner.sh` exits 2 for a missing brief, an unknown provider or a missing credential.
    Retrying one reports a broken component as a clean scan."""
    for status in (2,):
        assert plan.classify(status, model_failed=False, findings=0) == "wiring"
        assert plan.classify(status, model_failed=True, findings=0) == "wiring"


def test_another_nonzero_exit_without_a_failed_turn_is_the_harness():
    assert plan.classify(1, model_failed=False, findings=0) == "harness"
    assert plan.classify(137, model_failed=False, findings=0) == "harness"


def test_a_nonzero_exit_with_a_failed_turn_is_still_a_model_failure():
    """pi exits 0 on a failed call (verified against a 401 and a refused connection), but the
    event stream is what decides — not the exit code."""
    assert plan.classify(1, model_failed=True, findings=0) == "retry"
    assert plan.classify(1, model_failed=True, findings=1) == "warn"


def test_the_cli_prints_the_decision():
    out = subprocess.run([sys.executable, str(HERE / "plan.py"), "classify",
                          "--exit", "2", "--findings", "0"],
                         capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout.strip() == "wiring"
    out = subprocess.run([sys.executable, str(HERE / "plan.py"), "classify",
                          "--exit", "0", "--model-failed", "--findings", "3"],
                         capture_output=True, text=True)
    assert out.stdout.strip() == "warn"


def test_a_legacy_brief_is_still_a_component(tmp_path):
    """The fallback existed so a repository that had not renamed its briefs yet would keep working.
    Logging the old name and then rejecting it would have answered "nothing to scan" — the silent
    failure the fallback was for."""
    found, notes = plan.components(["services/api/HUNT.md", "services/billing/INVARIANTS.md"])
    assert found == ["services/api", "services/billing"]
    assert any("legacy component brief" in note for note in notes)
