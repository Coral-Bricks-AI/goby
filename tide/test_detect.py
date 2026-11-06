"""The detector: what a smell is, and which of the smells one sweep may spend a model on.

No git, no repository: `measure` takes the file list and a reader, so every rule here is a
unit test. `tracked_files` is the only part that shells out, and it is exercised against a real
checkout by the image's own smoke test.
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_tide_detect", HERE / "detect.py")
detect = importlib.util.module_from_spec(spec)
# Registered before exec because `dataclasses` looks the module up by name while decorating the
# classes below; without it a frozen dataclass raises from inside the decorator.
sys.modules["goby_tide_detect"] = detect
spec.loader.exec_module(detect)

THRESHOLDS = detect.Thresholds(max_file_lines=10, max_dir_files=2, max_file_imports=2)
EMPTY = detect.Config()


def reader(files: dict[str, str]):
    return lambda path: files.get(path)


def checks(found):
    return {(c["check"], c["path"], c["metric"]) for c in found}


# --- measuring -----------------------------------------------------------------------


def test_a_file_over_the_line_limit_is_measured_with_its_number():
    found = detect.measure(["src/a.py"], reader({"src/a.py": "x\n" * 11}), THRESHOLDS, EMPTY)
    assert checks(found) == {("max_file_lines", "src/a.py", 11)}
    (candidate,) = found
    assert candidate["threshold"] == 10 and candidate["unit"] == "lines"
    assert candidate["facts"] == {"lines": 11, "kind": "source"}


def test_a_file_at_the_limit_is_not_a_smell():
    """A threshold is a limit, not an average: 800 lines is allowed when 800 is the limit, or the
    document and the detector disagree about the same number."""
    assert detect.measure(["a.py"], reader({"a.py": "x\n" * 10}), THRESHOLDS, EMPTY) == []


def test_a_final_line_without_a_newline_counts():
    assert detect.line_count("a\nb") == 2
    assert detect.line_count("a\nb\n") == 2
    assert detect.line_count("") == 0


def test_a_directory_with_too_many_files_is_measured():
    files = ["svc/a.py", "svc/b.py", "svc/c.py", "other/d.py"]
    found = detect.measure(files, reader({}), THRESHOLDS, EMPTY)
    assert checks(found) == {("max_dir_files", "svc", 3)}
    assert found[0]["unit"] == "files"


def test_the_repository_root_is_never_a_directory_smell():
    """At the root the count is config files as often as source, and "you have 31 files at the top
    level" is the issue that gets the sweep uninstalled."""
    files = [f"f{n}.py" for n in range(5)]
    assert [c for c in detect.measure(files, reader({}), THRESHOLDS, EMPTY)
            if c["check"] == "max_dir_files"] == []


def test_import_lines_are_counted_across_languages():
    source = ("import os\nfrom x import y\nuse std::fmt;\n#include <stdio.h>\n"
              "const z = require('z');\nlet q = 1\n")
    found = detect.measure(["a.multi"], reader({"a.multi": source}), THRESHOLDS, EMPTY)
    assert checks(found) == {("max_file_imports", "a.multi", 5)}


def test_an_unreadable_or_binary_file_is_skipped_not_guessed():
    files = {"a.py": "", "b.py": "x\n" * 50}
    found = detect.measure(list(files), lambda path: None if path == "b.py" else files[path],
                           THRESHOLDS, EMPTY)
    assert found == [], "a file the detector cannot read must not become a candidate"


def test_binary_content_is_not_text(tmp_path):
    (tmp_path / "blob.bin").write_bytes(b"\x00\x01" * 100)
    assert detect.read_text(tmp_path, "blob.bin") is None


def test_an_oversized_file_is_not_counted(tmp_path):
    (tmp_path / "huge.json").write_text("x\n" * (detect.MAX_BYTES // 2 + 10))
    assert detect.read_text(tmp_path, "huge.json") is None, "2 MB of data is not a refactor plan"


def test_a_missing_file_is_not_an_error(tmp_path):
    assert detect.read_text(tmp_path, "nope.py") is None


# --- the repository's own config -----------------------------------------------------


def config_file(tmp_path, body) -> Path:
    path = tmp_path / ".goby" / "tide.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))
    return path


def test_a_missing_config_is_the_normal_case(tmp_path):
    config = detect.load_config(tmp_path / "absent.json")
    assert config.ignore == () and config.known == ()


def test_a_config_that_cannot_be_parsed_stops_the_sweep(tmp_path):
    """Sweeping with defaults is how a `known` entry someone just added silently has no effect."""
    path = tmp_path / "tide.json"
    path.write_text("{not json")
    with pytest.raises(SystemExit):
        detect.load_config(path)


def test_a_known_entry_names_a_real_check(tmp_path):
    """A typo in `check` would otherwise be a line that looks like a decision and is not one."""
    with pytest.raises(SystemExit):
        detect.load_config(config_file(tmp_path, {
            "known": [{"check": "max_file_line", "path": "a.py", "reason": "typo"}]}))


def test_a_known_entry_needs_a_reason(tmp_path):
    """The reason is what the next person reads; without it the list is an unexplained mute."""
    with pytest.raises(SystemExit):
        detect.load_config(config_file(tmp_path, {
            "known": [{"check": "max_file_lines", "path": "a.py"}]}))


def test_a_key_the_sweep_does_not_know_stops_it_rather_than_being_ignored(tmp_path):
    """The bare `{check, path, reason}` object that #100's footer used to print, and a typo'd
    `"Know"`, both used to load as an empty config: the reader believed they had recorded a
    decision and the smell was filed every sweep anyway."""
    for body in ({"check": "max_file_lines", "path": "a.py", "reason": "r"},
                 {"Know": [{"check": "max_file_lines", "path": "a.py", "reason": "r"}]}):
        with pytest.raises(SystemExit):
            detect.load_config(config_file(tmp_path, body))


def test_a_comment_is_allowed_beside_the_keys_it_explains(tmp_path):
    config = detect.load_config(config_file(tmp_path, {
        "_comment": ["why this file exists"], "known": []}))
    assert config.known == ()


def test_a_known_entry_stops_the_smell_being_filed(tmp_path):
    config = detect.load_config(config_file(tmp_path, {"known": [
        {"check": "max_file_lines", "path": "src/a.py", "reason": "generated table"}]}))
    found = detect.measure(["src/a.py"], reader({"src/a.py": "x\n" * 11}), THRESHOLDS, config)
    firing, suppressed = detect.apply_known(found, config)
    assert firing == []
    assert suppressed[0]["known_reason"] == "generated table"


def test_a_known_entry_that_stopped_firing_is_reported(tmp_path):
    """An ignore list nobody prunes is the same list in a year, hiding a smell that came back."""
    config = detect.load_config(config_file(tmp_path, {"known": [
        {"check": "max_file_lines", "path": "src/gone.py", "reason": "was long"}]}))
    assert detect.stale_known([], config)[0]["path"] == "src/gone.py"


def test_ignore_patterns_match_nested_and_top_level_files(tmp_path):
    """`**/*.min.js` written for nested files must catch the top-level one too, or the repository
    believes it and still gets an issue about `app.min.js`."""
    assert detect.ignored("app.min.js", ("**/*.min.js",))
    assert detect.ignored("static/vendor/app.min.js", ("**/*.min.js",))


def test_built_in_ignores_cover_generated_and_vendored_trees():
    for path in ("node_modules/x/index.js", "vendor/lib.c", "dist/app.js",
                 "app.min.css", "bun.lock", "api.generated.ts"):
        assert detect.ignored(path, ()), path
    assert not detect.ignored("src/app.ts", ())


def test_a_repository_ignore_adds_to_the_built_in_list():
    assert detect.ignored("generated/schema.ts", ("generated/**",))
    assert not detect.ignored("src/schema.ts", ("generated/**",))


# --- fingerprints and the model-call budget ------------------------------------------


def test_the_fingerprint_is_the_measurement_not_the_prose():
    """The cleaner fingerprints the title, because its findings are distinct events. A tide
    re-measures the same file every week, so a key containing a sentence the model wrote would
    file the same 1,432-line file again the moment the sentence changed."""
    a = detect.fingerprint("max_file_lines", "src/a.ts")
    assert a == detect.fingerprint("max_file_lines", "src/a.ts")
    assert a != detect.fingerprint("max_file_imports", "src/a.ts")
    assert a != detect.fingerprint("max_file_lines", "src/b.ts")
    assert len(a) == 12


def candidates(*rows) -> list[dict]:
    return [{"check": check, "path": path, "metric": metric, "threshold": 100,
             "unit": "lines", "facts": {}} for check, path, metric in rows]


def test_the_worst_offender_goes_first():
    picked = detect.rotate(candidates(("max_file_lines", "a", 120),
                                      ("max_file_lines", "b", 400)), 1, "sha")
    assert [c["path"] for c in picked] == ["b"]


def test_a_tie_does_not_always_spend_the_call_on_the_same_file():
    """With forty equally-bad files and one call, an alphabetical tie-break would never mention
    thirty-nine of them."""
    rows = candidates(*[("max_file_lines", f"f{n}", 200) for n in range(20)])
    seen = {detect.rotate(rows, 1, f"sha{n}")[0]["path"] for n in range(20)}
    assert len(seen) > 1


def test_the_same_commit_picks_the_same_candidates():
    """A re-run of one commit must be reproducible, or a sweep that failed halfway cannot be
    re-run to get the same answer."""
    rows = candidates(*[("max_file_lines", f"f{n}", 200) for n in range(20)])
    assert detect.rotate(rows, 3, "same") == detect.rotate(rows, 3, "same")


def test_rotate_never_exceeds_the_budget():
    rows = candidates(*[("max_file_lines", f"f{n}", 200) for n in range(20)])
    assert len(detect.rotate(rows, 3, "s")) == 3


# --- the whole sweep -----------------------------------------------------------------


def test_a_sweep_of_a_capped_tree_picks_a_subset_and_marks_nothing_else(tmp_path):
    files = {f"src/f{n}.py": "x\n" * 200 for n in range(5)}
    (tmp_path / "src").mkdir()
    for path in files:
        (tmp_path / path).write_text(files[path])
    config = detect.Config(known=(detect.Known("max_file_lines", "src/f0.py", "decided"),))
    plan, measured = detect.scan(tmp_path, "deadbeef", detect.Thresholds(10, 100, 2), config,
                                 max_items=2, files=sorted(files), read=reader(files))
    assert plan["candidates"] == 5
    assert plan["firing"] == 4, "the known entry is measured but not filed"
    assert len(plan["picked"]) == 2
    assert [c["path"] for c in plan["suppressed"]] == ["src/f0.py"]
    assert all(c["fingerprint"] for c in plan["picked"])
    # Every measurement, not the picked subset: `--close-gone` reads this file, and a smell over
    # today's model budget is still a smell.
    assert len(measured) == plan["candidates"] == 5


def test_every_shipped_module_compiles_without_escape_warnings():
    """A docstring that quotes `\\W` is a regular string: Python 3.12 warns and later versions will
    not read it as intended. The image's Python must compile every file it ships."""
    for path in sorted(HERE.glob("*.py")):
        done = subprocess.run([sys.executable, "-W", "error::SyntaxWarning", "-B",
                               "-m", "py_compile", str(path)],
                              capture_output=True, text=True)
        assert done.returncode == 0, (path.name, done.stderr)


def test_the_written_measurements_are_everything_not_the_picked_subset(tmp_path):
    """The file the filing step closes issues from is `--out`, so it has to be every measurement.
    Writing only the picked subset made `--close-gone` close an open issue for a smell that was
    merely over this sweep's model budget — a "resolved" comment about a file nobody touched."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    for n in range(4):
        (repo / f"big{n}.py").write_text("x = 1\n" * 30)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)

    measured, picked = tmp_path / "measured.jsonl", tmp_path / "picked.jsonl"
    assert detect.main(["scan", "--repo-dir", str(repo), "--sha", "deadbeef",
                        "--out", str(measured), "--candidates", str(picked),
                        "--max-items", "1", "--max-file-lines", "10",
                        "--max-dir-files", "100", "--max-file-imports", "100"]) == 0
    assert len(measured.read_text().splitlines()) == 4
    assert len(picked.read_text().splitlines()) == 1


# --- debt markers --------------------------------------------------------------------


def test_a_marker_is_counted_only_where_it_is_written():
    """`L.TODO` is a status constant in www's retirement.py, twenty times in one file. A bare
    `\\bTODO\\b` would have filed all twenty as debt; the marker has to follow a comment delimiter."""
    source = "\n".join([
        "status = L.TODO",                       # an identifier, not debt
        "x = 'TODO in a string'",                # a string, not a comment
        "// TODO: fold this into the reaper",    # js
        "# FIXME: the retry is unbounded",       # python
        "-- HACK: temporary",                    # sql
        "/* XXX: remove */",                     # c-style
        " * TODO: jsdoc line",                   # block comment continuation
        "<!-- TODO: docs -->",                   # html
    ])
    found = detect.measure(["a.multi"], reader({"a.multi": source}),
                           detect.Thresholds(10, 100, 100, max_todos=2), EMPTY)
    (candidate,) = found
    assert candidate["check"] == "max_todos"
    assert candidate["metric"] == 6, "the identifier and the string are not debt markers"
    assert candidate["unit"] == "markers"
    assert candidate["facts"]["first"].startswith("line 3")


def test_a_marker_count_at_the_limit_is_not_a_smell():
    source = "\n".join("// TODO: one" for _ in range(3))
    assert detect.measure(["a.ts"], reader({"a.ts": source}),
                          detect.Thresholds(10, 100, 100, max_todos=3), EMPTY) == []


def test_the_oldest_marker_decides_the_age(tmp_path):
    """One blame per file with markers; the age reported is the oldest of them, because "this file
    has a TODO from two years ago" is the claim, not the newest one."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git = lambda *args: subprocess.run(["git", *args], cwd=repo, check=True,
                                       capture_output=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    old = "2024-01-01T00:00:00+0000"
    (repo / "a.py").write_text("# TODO: two years ago\nx = 1\n")
    git("add", "-A")
    subprocess.run(["git", "commit", "-qm", "old"], cwd=repo, check=True,
                   env={"GIT_AUTHOR_DATE": old, "GIT_COMMITTER_DATE": old,
                        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(tmp_path)})
    (repo / "a.py").write_text("# TODO: two years ago\nx = 1\ny = 2\n")
    git("add", "-A")
    git("commit", "-qm", "recent")

    now = 1_800_000_000
    age = detect.blame_ages(repo, "a.py", [1], now=now)
    assert age is not None and age > 700, age
    picked = detect.measure(["a.py"], reader({"a.py": "# TODO: two years ago\nx = 1\n"}),
                            detect.Thresholds(1000, 100, 100, max_todos=10,
                                              max_todo_age_days=365),
                            EMPTY, age_of=lambda path, lines: 900)
    (candidate,) = picked
    assert candidate["check"] == "todo_age" and candidate["metric"] == 900
    assert candidate["unit"] == "days"


def test_an_age_under_the_threshold_is_not_filed():
    assert detect.measure(["a.py"], reader({"a.py": "# TODO: new\n"}),
                          detect.Thresholds(1000, 100, 100, max_todo_age_days=365),
                          EMPTY, age_of=lambda path, lines: 30) == []


def test_a_one_commit_clone_reports_no_history_rather_than_zero_days(tmp_path):
    """Every line blames to the head, so the check would say "0 days" forever and a repository full
    of ancient debt would look clean. Skipping it loudly is the only honest answer."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "a.py").write_text("# TODO: ancient but unattributable\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "only"], cwd=repo, check=True)
    assert detect.has_history(repo) is False
    plan, measured = detect.scan(repo, "deadbeef", detect.Thresholds(1000, 100, 100), EMPTY, 3)
    assert "no history" in plan["history"] or "one-commit" in plan["history"]
    assert [c["check"] for c in measured] == []


# --- per-kind thresholds --------------------------------------------------------------


def test_a_test_file_is_measured_against_the_test_limit():
    """The same 900 lines is a different smell in `tests/`: splitting a table of cases buys less
    than splitting a module with logic in it."""
    thresholds = detect.Thresholds(10, 100, 100, max_test_file_lines=50)
    test_file = detect.measure(["tests/test_a.py"], reader({"tests/test_a.py": "x\n" * 40}),
                               thresholds, EMPTY)
    assert test_file == [], "40 lines is under the 50-line test limit"

    over = detect.measure(["tests/test_a.py"], reader({"tests/test_a.py": "x\n" * 60}),
                          thresholds, EMPTY)
    assert over[0]["threshold"] == 50 and over[0]["facts"]["kind"] == "test"


def test_a_source_file_keeps_the_source_limit():
    thresholds = detect.Thresholds(10, 100, 100, max_test_file_lines=5000)
    (candidate,) = detect.measure(["src/a.py"], reader({"src/a.py": "x\n" * 40}),
                                 thresholds, EMPTY)
    assert candidate["threshold"] == 10 and candidate["facts"]["kind"] == "source"


def test_the_test_conventions_cover_the_usual_layouts():
    for path in ("tests/test_a.py", "pkg/a_test.py", "src/a.test.ts", "src/a.spec.tsx",
                 "web/__tests__/a.tsx", "testdata/x.json"):
        assert detect.is_test_path(path), path
    for path in ("src/a.py", "src/latest.ts", "pkg/testing.py"):
        assert not detect.is_test_path(path), path


def test_a_marker_below_the_first_line_of_a_hunk_is_still_blamed(tmp_path):
    """`git blame --line-porcelain` prints the hunk count on the first line only. Parsing just that
    form recorded the first line of every hunk and lost every marker below it, so the age of a file
    whose TODO sits under a comment block was reported from the wrong line — or not at all."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    old = "2024-01-01T00:00:00+0000"
    # One commit, three consecutive lines: line 1 carries the hunk count, lines 2-3 do not.
    (repo / "a.py").write_text("x = 1\n# TODO: second line of the hunk\ny = 2\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "only"], cwd=repo, check=True,
                   env={"GIT_AUTHOR_DATE": old, "GIT_COMMITTER_DATE": old,
                        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(tmp_path)})
    age = detect.blame_ages(repo, "a.py", [2], now=1_800_000_000)
    assert age is not None and age > 700, "line 2 is in the same hunk as line 1, not the head"


def test_a_file_the_reader_could_decode_does_not_crash_the_blame(tmp_path):
    """`read_text` decodes with `errors="replace"`, so a legacy-encoded file is measurable right up
    until blame decodes it strictly and raises out of the whole sweep."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "latin.py").write_bytes(b"# TODO: caf\xe9\nx = 1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "only"], cwd=repo, check=True)
    detect.blame_ages(repo, "latin.py", [1])  # must not raise


def test_the_plan_says_which_checks_ran_not_which_fired(tmp_path):
    """A check that found nothing was still evaluated, so the open issues it filed earlier may be
    closed. A check that could not run says nothing about anything."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "a.py").write_text("x = 1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "only"], cwd=repo, check=True)
    plan, _ = detect.scan(repo, "deadbeef", detect.Thresholds(1000, 100, 100), EMPTY, 3)
    assert "max_todos" in plan["checks"] and "max_file_lines" in plan["checks"]
    assert "todo_age" not in plan["checks"], "one commit, so the age question was not asked"

    plan, _ = detect.scan(HERE.parent, "deadbeef", detect.Thresholds(1000, 100, 100), EMPTY, 3,
                          age_of=lambda path, lines: None)
    assert "todo_age" in plan["checks"], "an injected age means the check ran"


def test_an_equal_pair_of_limits_still_calls_a_test_a_test():
    """`facts.kind` came from the two limits differing, so a repository that pinned them equal had
    its test files reported as source."""
    thresholds = detect.Thresholds(20, 100, 100, max_test_file_lines=20)
    (candidate,) = detect.measure(["tests/test_a.py"], reader({"tests/test_a.py": "x\n" * 40}),
                                  thresholds, EMPTY)
    assert candidate["facts"]["kind"] == "test"
