"""The environment the scan inherits, asserted from the two defects the cleaner filed against it.

Both were found by goby cleaners scanning its own copy, and neither is visible from a unit test of
the Python: they are contracts between `entrypoint.sh`, `cleaner.sh` and `prompt.md`, expressed in
shell. Asserting the shell is weak as tests go, and better than the alternative — the failures
were a prompt that named the wrong repository and a diff of a commit that was never fetched, and
both looked like a clean run.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def entrypoint() -> str:
    return (HERE / "entrypoint.sh").read_text()


def test_the_repository_reaches_the_scan():
    """`prompt.md` opens with "reviewing one component of `{{REPO}}`", and cleaner.sh falls back to
    the checkout directory's name. `env -i` did not carry REPO, so every scan of every repository
    said it was reviewing "repo" — a wrong value, which nothing downstream notices."""
    text = entrypoint()
    env_block = text[text.index("runuser -u agent -- env -i"):]
    env_block = env_block[:env_block.index("bash /opt/cleaners/cleaner.sh")]
    assert 'REPO="$REPO"' in env_block


def test_a_failed_predecessor_fetch_clears_the_sha():
    """`--before` is passed unconditionally, so a set-but-unfetched sha reaches the prompt: the
    cleaner is told to diff a commit the one-commit clone does not have. Clearing it is what makes
    "no predecessor" true rather than merely logged."""
    text = entrypoint()
    log = text.index('log "no predecessor; the clone has one commit and no diff"')
    branch = text[text.rindex("\nelse", 0, log):text.index("\nfi", log)]
    assert 'BEFORE=""' in branch


def test_the_scan_gets_no_token_and_one_key():
    """The allowlist is the isolation boundary; a variable added without thinking is how a
    credential reaches the agent's shell."""
    text = entrypoint()
    env_block = text[text.index("runuser -u agent -- env -i"):]
    env_block = env_block[:env_block.index("bash /opt/cleaners/cleaner.sh")]
    assert "GITHUB_TOKEN" not in env_block
    assert '"${key_env[@]}"' in env_block


def test_a_failing_picker_is_not_reported_as_nothing_to_scan():
    """`plan.py picked` exiting non-zero used to produce an empty component list, which the script
    answered with "nothing to scan" and exit 0 — a bad input silently turned the cleaner off."""
    text = entrypoint()
    picked = text[text.index("PIPESTATUS[1]"):]
    assert "PICK_STATUS" in picked
    assert 'exit 2' in picked.split("nothing to scan")[0]


def test_the_images_create_the_user_the_entrypoints_drop_to():
    """`lib.sh` and both entrypoints drop to `agent`; the images must create that user."""
    for image in (HERE / "Dockerfile", HERE.parent / "base" / "Dockerfile"):
        text = image.read_text()
        assert "useradd --create-home --uid 10001 agent" in text, image


def test_paths_reach_the_picker_unquoted():
    """A non-ASCII filename is C-quoted by git (`"\\303\\251.md"`), and `plan.py` compares the
    changed list against the directories it read from `ls-files`. Both reads must disable
    `core.quotePath`, or a push that only touched such a file matches no component and the job
    logs "nothing to scan" and exits 0."""
    text = entrypoint()
    for command in ("ls-files -- '*INVARIANTS.md'", 'diff --name-only "$BEFORE" "$HEAD_SHA"'):
        start = text.index(command)
        assert "-c core.quotePath=false" in text[start - 40:start], command


def test_the_prompt_renders_when_a_changed_path_is_not_utf8(tmp_path):
    """The changed list carries raw path bytes since `core.quotePath=false`, and `cleaner.sh` is
    the third reader of that file. Reading it strictly aborted the render, so every component of
    the push went unscanned — the picker fix undone one step later."""
    import os
    import subprocess
    import sys

    text = (HERE / "cleaner.sh").read_text()
    block = text.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    changed = tmp_path / "changed.txt"
    changed.write_bytes(b"docs/caf\xe9.md\nsvc/a.py\n")
    charter = tmp_path / "INVARIANTS.md"
    charter.write_text("1. Nothing here is false.\n")
    rules = tmp_path / "AGENTS.md"
    rules.write_text("rules\n")
    env = {**os.environ, "CLEANERS_PROMPT_DIR": str(HERE), "REPO": "owner/repo"}
    out = subprocess.run(
        [sys.executable, "-c", block, "svc", "deadbeef", "", str(charter), str(rules),
         str(changed), str(tmp_path)],
        capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    assert "svc/a.py" in out.stdout
    assert "caf\ufffd.md" in out.stdout


def test_the_prompt_renders_a_brief_or_rules_file_that_is_not_utf8(tmp_path):
    """The brief and the repo rules are prompt context too, and both were still read with
    `read_text()`. A Latin-1 `AGENTS.md` is one committed file that makes every scan of every
    component fail at the render — `harness` in the log, nothing filed, forever."""
    import os
    import subprocess
    import sys

    text = (HERE / "cleaner.sh").read_text()
    block = text.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    changed = tmp_path / "changed.txt"
    changed.write_text("svc/a.py\n")
    charter = tmp_path / "INVARIANTS.md"
    charter.write_bytes(b"Caf\xe9: invariant one\n")
    rules = tmp_path / "AGENTS.md"
    rules.write_bytes(b"r\xe9gle\n")
    env = {**os.environ, "CLEANERS_PROMPT_DIR": str(HERE), "REPO": "owner/repo"}
    out = subprocess.run(
        [sys.executable, "-c", block, "svc", "deadbeef", "", str(charter), str(rules),
         str(changed), str(tmp_path)],
        capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    assert "Caf\ufffd: invariant one" in out.stdout
    assert "r\ufffdgle" in out.stdout
