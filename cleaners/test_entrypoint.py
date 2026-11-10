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
    env_block = text[text.index("goby_run_as_agent"):]
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


def test_the_scan_gets_no_token_and_no_key():
    """The allowlist is the isolation boundary; a variable added without thinking is how a
    credential reaches the agent's shell. The model key is not a name that can be forgotten
    here: the agent gets a dummy and the root-only proxy holds the real one."""
    text = entrypoint()
    env_block = text[text.index("goby_run_as_agent"):]
    env_block = env_block[:env_block.index("bash /opt/cleaners/cleaner.sh")]
    assert "GITHUB_TOKEN" not in env_block
    for credential in ("CORALBRICKS_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
                       "DEEPINFRA_API_KEY"):
        assert credential not in env_block, credential
    assert "GOBY_MODEL_KEY=dummy-proxy-key" in env_block


def test_the_key_and_the_proxy_are_the_base_images_and_not_a_second_copy():
    """The point of the move: one secret convention, in `base/lib.sh`, with the real key in a
    root-only file the agent cannot read. A local edit that re-adds a provider key to the
    agent's environment is the regression this pins."""
    text = entrypoint()
    assert "source /opt/goby/lib.sh" in text
    assert "goby_key_to_file" in text and "goby_proxy_start" in text
    assert "goby_proxy_stop" in text, "the proxy must not outlive the task"
    assert 'cp /opt/goby/models/models.json "$agent_home/models.json"' in text
    assert "$MODELS_DIR/$provider.json" not in text, "the agent gets the sanitized file, not one per provider"
    # The per-provider files stay, root-side only, because model_check.py is the credential gate.
    assert 'MODELS_DIR=/opt/cleaners/models' in text
    assert "goby_token_to_file" in text and "/root/.cleaners-token" not in text


def test_an_explicitly_empty_scheme_survives_the_proxy_default(tmp_path):
    """Anthropic's `x-api-key` carries no scheme. `scheme="${3:-Bearer }"` replaces an empty-but-
    passed argument with the default, so the proxy sent `x-api-key: Bearer <key>` and the provider
    rejected it — a high-severity regression against an Anthropic-only consumer (#128/#129).

    Runs the real `goby_proxy_start` with a `node` stand-in, so this is the shell's behaviour and
    not a grep of it."""
    import subprocess

    lib = HERE.parent / "base" / "lib.sh"
    record = tmp_path / "scheme"
    runner = tmp_path / "run.sh"
    runner.write_text(f"""set -uo pipefail
# The stand-in records what the proxy *would* have been given. Both calls (the background proxy
# and the readiness poll) write it; the last one wins and they agree.
node() {{
  # Only the proxy invocation carries the scheme; the readiness poll does not.
  [[ -n "${{GOBY_KEY_SCHEME+x}}" ]] && printf 'scheme=[%s]' "$GOBY_KEY_SCHEME" > "{record}"
  return 0
}}
export -f node 2>/dev/null || true
source "{lib}"
GOBY_PROXY_PID="{tmp_path}/pid"
GOBY_PROXY_PORT=18099
GOBY_HOME="{HERE.parent}/base"
goby_proxy_start "https://example.invalid" "$1" "$2"
""")
    for header, scheme, want in (("x-api-key", "", "scheme=[]"),
                                 ("authorization", "Bearer ", "scheme=[Bearer ]")):
        done = subprocess.run(["bash", str(runner), header, scheme],
                              capture_output=True, text=True)
        assert done.returncode == 0, done.stderr
        assert record.read_text() == want, (header, scheme, record.read_text())


def test_the_provider_header_reaches_the_proxy():
    """Anthropic authenticates with `x-api-key` and no scheme. The proxy rewrites only the header
    it is told to, so a missing override sends the provider the agent's dummy."""
    text = entrypoint()
    block = text[text.index("ensure_proxy() {"):text.index("trap goby_proxy_stop EXIT")]
    assert 'header="x-api-key"; scheme=""' in block
    assert 'goby_proxy_start "$upstream" "$header" "$scheme"' in block


def test_a_retry_on_another_provider_restarts_the_proxy():
    """The proxy reads its upstream once at startup, and FALLBACK_MODEL may name a different
    provider. Without a restart the retry calls the first provider's upstream and reads as a
    model error."""
    text = entrypoint()
    block = text[text.index("ensure_proxy() {"):text.index("trap goby_proxy_stop EXIT")]
    assert "goby_proxy_stop" in block and "goby_proxy_start" in block
    assert '[[ "$PROXY_PROVIDER" == "$provider" ]]' in block
    assert 'ensure_proxy "$provider"' in text


def test_a_failing_picker_is_not_reported_as_nothing_to_scan():
    """`plan.py picked` exiting non-zero used to produce an empty component list, which the script
    answered with "nothing to scan" and exit 0 — a bad input silently turned the cleaner off."""
    text = entrypoint()
    picked = text[text.index("PIPESTATUS[1]"):]
    assert "PICK_STATUS" in picked
    assert 'exit 2' in picked.split("nothing to scan")[0]


def test_the_images_create_the_user_the_entrypoints_drop_to():
    """`lib.sh` and the entrypoints drop to `agent`, so `goby-base` creates it. A cleaner that
    still created its own uid would be a second source of truth for the same user."""
    base = (HERE.parent / "base" / "Dockerfile").read_text()
    assert "useradd --create-home --uid 10001 agent" in base
    cleaners = (HERE / "Dockerfile").read_text()
    assert "useradd" not in cleaners, "the base image owns the user"
    assert "FROM ${BASE_IMAGE}" in cleaners


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


def test_every_scan_reports_where_its_wall_clock_went():
    """The usage line says what a scan cost in tokens; this one says what it spent its time on —
    the requests pi timed, the calls' own clocks, the output split. A cleaner is the most expensive
    thing goby runs, and it reported cost with no way to tell thinking from probing."""
    text = entrypoint()
    scan_block = text[text.index('run_scan "$dir" "$MODEL"'):]
    scan_block = scan_block[:scan_block.index("# What to do about this scan")]
    assert "/opt/common/timing.py" in scan_block
    assert '--agent-seconds "$SCAN_ELAPSED"' in scan_block
    # Instrumentation never decides: an unreadable stream must not fail the scan it describes.
    assert "|| true" in scan_block[scan_block.index("timing.py"):].split("\n")[0] + \
        scan_block[scan_block.index("timing.py"):].split("\n")[1], scan_block
    # A retry is its own scan, at fallback cost, and is the one whose findings get filed.
    retry_block = text[text.index('run_scan "$dir" "$FALLBACK_MODEL"'):]
    retry_block = retry_block[:retry_block.index("model_error=0")]
    assert "/opt/common/timing.py" in retry_block
    assert '$OUT/agent/$SLUG-retry/events.jsonl' in retry_block
