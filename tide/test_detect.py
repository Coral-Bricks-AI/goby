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
    assert candidate["facts"] == {"lines": 11}


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
