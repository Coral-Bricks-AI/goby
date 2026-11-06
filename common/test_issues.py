"""The shared filing machinery: two labels, one read, and a marker only at the top.

No network: `_http` is never called directly here; every function takes the http callable it
should use, which is also how the products stub it in their own tests.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_common_issues", HERE / "issues.py")
issues = importlib.util.module_from_spec(spec)
sys.modules["goby_common_issues"] = issues
spec.loader.exec_module(issues)

MARKER = issues.Marker(
    token="goby-test",
    pattern=(r"<!--\s+[A-Za-z0-9._-]+\s+fp=(?P<fp>[0-9a-f]{12})"
             r"\s+check=(?P<check>[a-z_]+)\s+path=(?P<path>.+?)\s*-->"),
    template="<!-- {token} fp={fp} check={check} path={path} -->",
)


def product(label="goby-test") -> issues.Product:
    return issues.Product(label=issues.Label(label, "0e8a16", f"filed by {label}"),
                          marker=MARKER)


class FakeGitHub:
    def __init__(self, create_status=201, list_status=200, listed=()):
        self.calls, self.created, self.created_labels = [], [], []
        self.create_status, self.list_status, self.listed = create_status, list_status, list(listed)

    def __call__(self, method, path, token, payload=None):
        self.calls.append((method, path, payload))
        if "/labels" in path:
            self.created_labels.append(payload["name"])
            return 422, {"message": "already exists"}
        if method == "GET" and "/issues?" in path:
            return self.list_status, self.listed if self.list_status == 200 else "bad gateway"
        if method == "POST" and path.endswith("/issues"):
            self.created.append(payload)
            return self.create_status, {"html_url": f"https://github.com/o/r/issues/{len(self.created)}"}
        return 200, {}


# --- the marker ----------------------------------------------------------------------


def test_the_marker_renders_and_parses_to_the_same_fields():
    body = MARKER.render(token=MARKER.token, fp="0123456789ab", check="max_file_lines",
                         path="src/a b.ts")
    parsed = MARKER.parse(body)
    assert parsed.group("fp") == "0123456789ab"
    assert parsed.group("path") == "src/a b.ts", "a path may contain a space"
    assert MARKER.token == "goby-test"


def test_a_marker_anywhere_but_the_top_is_not_a_filing():
    """A scan of this repository has markers in its issue bodies. Reading one there suppressed
    the real finding it named, and spent the daily budget that finding needed."""
    body = "**Reproduced with:**\n\n```\n" + MARKER.render(
        token=MARKER.token, fp="0" * 12, check="max_file_lines", path="x") + "\n```\n"
    assert MARKER.parse(body) is None


def test_leading_whitespace_is_tolerated_but_a_prefix_is_not():
    marker = MARKER.render(token=MARKER.token, fp="a" * 12, check="max_file_lines", path="x")
    assert MARKER.parse("\n  " + marker) is not None
    assert MARKER.parse("quoted: " + marker) is None


# --- labels --------------------------------------------------------------------------


def test_every_issue_carries_the_product_label_first_and_the_general_one_second():
    """GitHub's issue list shows the first label, so a human sees which product filed it before
    they see that goby did."""
    assert product("goby-tide").labels == ["goby-tide", "goby"]
    assert [label.name for label in product().all_labels()] == ["goby-test", "goby"]


def test_a_renamed_product_keeps_its_marker_token():
    renamed = product().renamed("team tide")
    assert renamed.label.name == "team tide"
    assert renamed.marker.token == "goby-test", "the marker is the filing's identity"
    assert renamed.labels == ["team tide", "goby"]


def test_renaming_to_nothing_is_a_no_op():
    assert product().renamed(None).label.name == "goby-test"


def test_both_labels_are_created_and_an_existing_one_is_not_an_error():
    gh = FakeGitHub()
    issues.ensure_labels("o/r", "tok", product(), http=gh)
    assert gh.created_labels == ["goby-test", "goby"]


def test_a_label_that_cannot_be_created_is_a_warning_not_a_failure(capsys):
    issues.ensure_labels("o/r", "tok", product(), http=lambda *a, **k: (500, "boom"))
    assert "warning: label" in capsys.readouterr().err


# --- reading the history -------------------------------------------------------------


def test_the_read_asks_for_the_state_it_was_given(monkeypatch):
    """The cleaner wants closed issues (a "not a bug" must not return); the tide does not (code
    grows back). One function, and the state is an argument rather than a default nobody sees."""
    seen: list[str] = []

    def fake(method, path, token, payload=None):
        seen.append(path)
        return 200, []

    monkeypatch.setattr(issues, "_http", fake)
    issues.list_labelled("o/r", "tok", "goby-tide", state="open")
    issues.list_labelled("o/r", "tok", "goby-cleaners", state="all")
    assert "state=open" in seen[0] and "labels=goby-tide" in seen[0]
    assert "state=all" in seen[1] and "labels=goby-cleaners" in seen[1]


def test_a_label_with_a_space_is_encoded_into_the_read():
    seen: list[str] = []

    def fake(method, path, token, payload=None):
        seen.append(path)
        return 200, []

    issues.list_labelled("o/r", "tok", "team cleaners", http=fake)
    assert " " not in seen[0]
    assert "labels=team%20cleaners" in seen[0]


def test_a_failed_read_is_none_and_never_an_empty_list():
    """An empty list and a failed read mean opposite things: "nothing filed yet" versus "do not
    know what is filed". Treating them alike re-files everything already open."""
    assert issues.list_labelled("o/r", "tok", "x", http=FakeGitHub(list_status=502)) is None


def test_a_truncated_read_is_none_rather_than_a_prefix():
    full_page = [{"number": n} for n in range(100)]
    assert issues.list_labelled("o/r", "tok", "x", max_pages=1,
                                http=FakeGitHub(listed=full_page)) is None


def test_a_history_that_ends_exactly_at_the_bound_is_complete():
    full_page = [{"number": n} for n in range(100)]

    def fake(method, path, token, payload=None):
        return 200, full_page if path.endswith("page=1") else []

    assert len(issues.list_labelled("o/r", "tok", "x", max_pages=1, http=fake)) == 100


# --- filing and closing --------------------------------------------------------------


def test_one_issue_per_item_under_both_labels_and_no_assignee():
    gh = FakeGitHub()
    urls, failures = issues.file_issues("o/r", "tok", product("goby-tide"), [1, 2],
                                        lambda item: (f"t{item}", f"b{item}"), http=gh)
    assert failures == [] and urls == ["https://github.com/o/r/issues/1",
                                       "https://github.com/o/r/issues/2"]
    assert [c["labels"] for c in gh.created] == [["goby-tide", "goby"], ["goby-tide", "goby"]]
    assert all("assignees" not in c for c in gh.created), "humans route issues"


def test_nothing_is_filed_and_no_label_is_created_for_an_empty_batch():
    gh = FakeGitHub()
    assert issues.file_issues("o/r", "tok", product(), [], lambda item: ("t", "b"), http=gh) == ([], [])
    assert gh.calls == [], "an empty sweep must not touch the API"


def test_a_rejected_filing_reaches_the_caller():
    gh = FakeGitHub(create_status=403)
    _, failures = issues.file_issues("o/r", "tok", product(), [1], lambda i: ("t", "b"), http=gh)
    assert failures and "403" in failures[0]


def test_closing_comments_first_and_then_closes():
    gh = FakeGitHub()
    assert issues.close_issue("o/r", "tok", 7, "gone", http=gh)
    methods = [(m, p) for m, p, _ in gh.calls if not p.endswith("/labels")]
    assert methods == [("POST", "/repos/o/r/issues/7/comments"),
                       ("PATCH", "/repos/o/r/issues/7")]


def test_a_close_that_fails_is_reported():
    def fake(method, path, token, payload=None):
        return (200, {}) if method == "POST" else (500, "boom")

    assert issues.close_issue("o/r", "tok", 7, "gone", http=fake) is False


# --- the index both products build ---------------------------------------------------


def test_the_index_reads_the_leading_marker_only():
    good = MARKER.render(token=MARKER.token, fp="a" * 12, check="max_file_lines", path="x")
    quoted = MARKER.render(token=MARKER.token, fp="b" * 12, check="max_file_lines", path="y")
    index = issues.marker_index([
        {"number": 1, "body": good + "\n\nevidence"},
        {"number": 2, "body": "```\n" + quoted + "\n```"},
        {"number": 3, "body": "no marker"},
    ], MARKER)
    assert list(index) == ["a" * 12], "a quoted marker must not enter the index"


def test_the_first_issue_wins_for_a_fingerprint():
    body = MARKER.render(token=MARKER.token, fp="a" * 12, check="max_file_lines", path="x")
    index = issues.marker_index([{"number": 1, "body": body}, {"number": 2, "body": body}], MARKER)
    assert index["a" * 12]["number"] == 1


def test_a_bare_repository_name_is_normalised_the_same_way_for_reading_and_writing():
    assert issues.full_name("widgets") == issues.full_name("Coral-Bricks-AI/widgets")
    assert issues.full_name("acme/widgets") == "acme/widgets"


def test_the_shared_module_is_still_python_the_image_can_compile():
    import subprocess

    done = subprocess.run([sys.executable, "-W", "error::SyntaxWarning", "-B",
                           "-m", "py_compile", str(HERE / "issues.py")],
                          capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_the_page_bound_covers_a_year_of_filings():
    """At the shipped tide cap of five a day, and the cleaner's twenty-five, the bound must not be
    the thing that stops dedupe working."""
    assert issues.MAX_LABELLED_PAGES * 100 >= 25 * 365


def test_json_round_trips_because_every_record_does():
    """A marker travels through the API as a JSON string and comes back with the same bytes; the
    grammar is matched against the body, not against a parsed field."""
    body = MARKER.render(token=MARKER.token, fp="a" * 12, check="max_file_lines",
                         path="services/api v2/x.py")
    parsed = MARKER.parse(json.loads(json.dumps(body)))
    assert parsed.group("path") == "services/api v2/x.py"
