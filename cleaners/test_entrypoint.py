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
    """`lib.sh` and both entrypoints drop to `agent`. The rename updated them and left the two
    Dockerfiles creating only `hunter`, which the reviewer found on the rename pull request — a
    container that cannot `runuser` to a user that does not exist fails after the clone."""
    for image in (HERE / "Dockerfile", HERE.parent / "base" / "Dockerfile"):
        text = image.read_text()
        assert "useradd --create-home --uid 10001 agent" in text, image
        # Nothing may still reference the name the role used to have, or a chown or a home
        # directory would point at a user that does not exist.
        assert "hunter" not in text, image
