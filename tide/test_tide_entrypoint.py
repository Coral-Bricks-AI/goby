"""The credential boundary between `entrypoint.sh`, `tide.sh` and the key proxy.

These are contracts expressed in shell, and the regression they pin is invisible to a unit test of
the Python: tide used to copy the selected provider's real models file into the agent's directory
and hand its process the provider key. The base image exists so that no product does that — the
agent gets a dummy credential and loopback, and the real key stays in a root-only file the proxy
reads. The same contract is tested for cleaners in `cleaners/test_entrypoint.py`.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def entrypoint() -> str:
    return (HERE / "entrypoint.sh").read_text()


def tide_script() -> str:
    return (HERE / "tide.sh").read_text()


def test_the_scan_gets_no_token_and_no_key():
    """The allowlist is the isolation boundary; a variable added without thinking is how a
    credential reaches the agent. The one model credential the agent gets is the dummy the proxy
    replaces with the real key."""
    text = entrypoint()
    env_block = text[text.index("goby_run_as_agent"):]
    env_block = env_block[:env_block.index("bash /opt/tide/tide.sh")]
    assert "GITHUB_TOKEN" not in env_block
    for credential in ("CORALBRICKS_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
                       "DEEPINFRA_API_KEY"):
        assert credential not in env_block, credential
    assert "GOBY_MODEL_KEY=dummy-proxy-key" in env_block


def test_the_key_and_the_proxy_are_the_base_images_and_not_a_second_copy():
    """One secret convention, in `base/lib.sh`, with the real key in a root-only file the agent
    cannot read. A local edit that re-adds a provider key to the agent's environment is the
    regression this pins."""
    text = entrypoint()
    assert "source /opt/goby/lib.sh" in text
    assert "goby_key_to_file" in text and "goby_proxy_start" in text
    assert "goby_proxy_stop" in text, "the proxy must not outlive the sweep"
    assert 'cp /opt/goby/models/models.json "$agent_home/models.json"' in text
    assert "$MODELS_DIR/$provider.json" not in text, "the agent gets the sanitized file, not one per provider"
    # The per-provider files stay, root-side only, because model_check.py is the credential gate.
    assert "MODELS_DIR=/opt/tide/models" in text
    assert "goby_token_to_file" in text and "/root/.tide-token" not in text
    # The launch goes through the base helper; a hand-written `runuser … env -i` is how the real
    # key got back into the agent's environment in the first place.
    assert "runuser -u agent -- env -i" not in text


def test_the_proxy_restarts_when_a_retry_lands_on_another_provider():
    """The proxy reads its upstream once. A retry on `FALLBACK_MODEL` may switch provider, so the
    run has to restart it; it must remember the provider it already holds rather than restart per
    scan."""
    text = entrypoint()
    block = text[text.index("ensure_proxy() {"):text.index("trap goby_proxy_stop EXIT")]
    assert '[[ "$PROXY_PROVIDER" == "$provider" ]]' in block
    assert "goby_proxy_stop" in block and "goby_proxy_start" in block
    assert 'header="x-api-key"; scheme=""' in block, "Anthropic's x-api-key carries no scheme"
    assert 'goby_proxy_start "$upstream" "$header" "$scheme"' in block


def test_the_agent_script_requires_the_dummy_not_a_provider_key():
    """`pi` refuses to start when a variable its models file interpolates is unset. With the
    sanitized file that variable is `GOBY_MODEL_KEY`; demanding a provider key here would mean the
    real one is still expected in the agent's environment."""
    text = tide_script()
    assert 'GOBY_MODEL_KEY:?GOBY_MODEL_KEY must be set' in text
    for credential in ("CORALBRICKS_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
                       "DEEPINFRA_API_KEY"):
        assert f"{credential}:?" not in text, credential


def test_every_scan_reports_where_its_wall_clock_went():
    """The usage line says what a scan cost in tokens; this one says what it spent its time on —
    the requests pi timed, the calls' own clocks, the output split. Instrumentation only, so it is
    `|| true`: a sweep must not fail because a report about it did."""
    text = entrypoint()
    block = text[text.index('run_scan "$check" "$path"'):]
    block = block[:block.index("summarize_run.py --timeouts")]
    assert "/opt/common/timing.py" in block
    assert '--agent-seconds "$SCAN_ELAPSED"' in block
    call = block[block.index("SCAN_TIMING="):block.index('if [[ -n "$SCAN_TIMING" ]]')]
    assert "|| true" in call
