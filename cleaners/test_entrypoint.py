"""The environment the hunt inherits, asserted from the two defects the hunter filed against it.

Both were found by goby cleaners hunting its own copy, and neither is visible from a unit test of
the Python: they are contracts between `entrypoint.sh`, `hunt.sh` and `prompt.md`, expressed in
shell. Asserting the shell is weak as tests go, and better than the alternative — the failures
were a prompt that named the wrong repository and a diff of a commit that was never fetched, and
both looked like a clean run.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def entrypoint() -> str:
    return (HERE / "entrypoint.sh").read_text()


def test_the_repository_reaches_the_hunt():
    """`prompt.md` opens with "reviewing one component of `{{REPO}}`", and hunt.sh falls back to
    the checkout directory's name. `env -i` did not carry REPO, so every hunt of every repository
    said it was reviewing "repo" — a wrong value, which nothing downstream notices."""
    text = entrypoint()
    env_block = text[text.index("runuser -u hunter -- env -i"):]
    env_block = env_block[:env_block.index("bash /opt/cleaners/hunt.sh")]
    assert 'REPO="$REPO"' in env_block


def test_a_failed_predecessor_fetch_clears_the_sha():
    """`--before` is passed unconditionally, so a set-but-unfetched sha reaches the prompt: the
    hunter is told to diff a commit the one-commit clone does not have. Clearing it is what makes
    "no predecessor" true rather than merely logged."""
    text = entrypoint()
    log = text.index('log "no predecessor; the clone has one commit and no diff"')
    branch = text[text.rindex("\nelse", 0, log):text.index("\nfi", log)]
    assert 'BEFORE=""' in branch


def test_the_hunt_gets_no_token_and_one_key():
    """The allowlist is the isolation boundary; a variable added without thinking is how a
    credential reaches the agent's shell."""
    text = entrypoint()
    env_block = text[text.index("runuser -u hunter -- env -i"):]
    env_block = env_block[:env_block.index("bash /opt/cleaners/hunt.sh")]
    assert "GITHUB_TOKEN" not in env_block
    assert '"${key_env[@]}"' in env_block
