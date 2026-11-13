"""One version, in one file — and the check that keeps it that way.

Three things need goby's version: the reviewer's body marker (TypeScript, compiled, cannot read a
file at run time), the cleaners' and the tide's issue markers (Python, read `VERSION` beside this
module), and the release tooling (npm's `package.json`). A number in three places drifts, and a
record that names the wrong version puts a data point under a release that did not produce it.
This file is the cost of that, and it is cheaper than any of the alternatives.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
spec = importlib.util.spec_from_file_location("goby_common_issues", HERE / "issues.py")
issues = importlib.util.module_from_spec(spec)
# Registered before execution: `issues.py` declares dataclasses, and dataclasses look their own
# module up in `sys.modules` while building the class.
sys.modules[spec.name] = issues
spec.loader.exec_module(issues)


def test_the_version_file_is_the_one_the_package_declares():
    assert issues.version() == json.loads((REPO / "package.json").read_text())["version"]


def test_the_reviewer_agrees_with_the_version_file():
    """`src/identity.ts` is compiled, so it carries a literal. Drift here is silent everywhere
    except in the data: a review body would name one version while the cleaners' issues named
    another, and both would look authoritative."""
    source = (REPO / "src" / "identity.ts").read_text()
    literal = re.search(r"REVIEW_VERSION = '([^']+)'", source)
    assert literal is not None, "REVIEW_VERSION moved or was renamed"
    assert literal.group(1) == issues.version()


def test_a_version_the_marker_grammar_cannot_carry_is_dropped(monkeypatch, tmp_path):
    """A version is written into a marker a regular expression reads. Spaces would break the
    grammar, and a marker the next run cannot parse is the same defect filed again every day —
    so an unusable version costs a field rather than the dedupe."""
    bad = tmp_path / "VERSION"
    bad.write_text("0.4.0 release candidate\n")
    monkeypatch.setattr(issues, "VERSION", bad)
    assert issues.version() is None
    assert issues.version_field() == ""


def test_a_missing_version_file_is_a_marker_with_no_version(monkeypatch, tmp_path):
    monkeypatch.setattr(issues, "VERSION", tmp_path / "nope")
    assert issues.version_field() == ""
    marker = issues.Marker(token="goby-x", pattern=r"<!-- x (?P<a>\w+)(?P<version>.*) -->",
                           template="<!-- x {a}{version} -->")
    rendered = marker.render(a="1")
    assert rendered == "<!-- x 1 -->"
    assert marker.parse(rendered) is not None


def test_the_suffix_is_pre_spaced_so_a_marker_has_one_grammar(monkeypatch, tmp_path):
    """` v=0.4.0`, not `0.4.0`: the template carries no separator, so a run without a version
    writes byte-for-byte what it wrote before the version existed."""
    good = tmp_path / "VERSION"
    good.write_text("1.2.3\n")
    monkeypatch.setattr(issues, "VERSION", good)
    assert issues.version_field() == " v=1.2.3"


@pytest.mark.parametrize("value", ["0.4.0", "0.4.0-rc.1", "1.0.0+build.5"])
def test_a_semver_shaped_version_is_carried(monkeypatch, tmp_path, value):
    """The file holds the number, not the tag (`0.4.0`, not `review-v0.4.0`)."""
    path = tmp_path / "VERSION"
    path.write_text(value + "\n")
    monkeypatch.setattr(issues, "VERSION", path)
    assert issues.version() == value
