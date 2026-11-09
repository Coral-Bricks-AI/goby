"""Tests for the model-credential check: it decides whether the system does anything."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("goby_cleaners_model_check",
                                             HERE / "model_check.py")
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)


def models_dir(tmp_path, files: dict[str, dict]) -> Path:
    d = tmp_path / "models"
    d.mkdir()
    for name, body in files.items():
        (d / f"{name}.json").write_text(json.dumps(body))
    return d


CORAL = {"providers": {"coral": {"apiKey": "$CORALBRICKS_API_KEY",
                                 "headers": {"x-session-id": "$CLEANERS_SESSION_ID"},
                                 "models": [{"id": "deepseek-v4.1-flash-fast"}]}}}
ANTHROPIC = {"providers": {"anthropic": {"apiKey": "$ANTHROPIC_API_KEY"}}}


def test_harness_variables_are_not_credentials(tmp_path):
    """`models/coral.json` interpolates CLEANERS_SESSION_ID for spend attribution. It does
    not exist yet when this check runs, and treating it as a credential refused every
    default scan."""
    d = models_dir(tmp_path, {"coral": CORAL})
    assert mc.credential_vars(d / "coral.json") == {"CORALBRICKS_API_KEY"}
    model, why = mc.choose(d, "coral/x", "coral/x", {"CORALBRICKS_API_KEY": "ak_1"})
    assert model == "coral/x" and why == ""


def test_a_missing_credential_is_named(tmp_path):
    d = models_dir(tmp_path, {"coral": CORAL})
    model, why = mc.choose(d, "coral/x", "coral/x", {})
    assert model is None
    assert "CORALBRICKS_API_KEY unset" in why


def test_a_provider_without_a_models_file_is_named(tmp_path):
    d = models_dir(tmp_path, {"coral": CORAL})
    model, why = mc.choose(d, "google/x", "coral/x", {"CORALBRICKS_API_KEY": "ak_1"})
    assert model == "coral/x"
    model, why = mc.choose(d, "google/x", "google/y", {"CORALBRICKS_API_KEY": "ak_1"})
    assert model is None and "no models/google.json" in why


def test_the_requested_model_wins_when_it_has_a_key(tmp_path):
    d = models_dir(tmp_path, {"coral": CORAL, "anthropic": ANTHROPIC})
    env = {"CORALBRICKS_API_KEY": "ak_1", "ANTHROPIC_API_KEY": "sk-ant-1"}
    assert mc.choose(d, "anthropic/claude", "coral/x", env)[0] == "anthropic/claude"


def test_a_dead_provider_falls_back_to_ours(tmp_path):
    d = models_dir(tmp_path, {"coral": CORAL, "anthropic": ANTHROPIC})
    model, _ = mc.choose(d, "anthropic/claude", "coral/x", {"CORALBRICKS_API_KEY": "ak_1"})
    assert model == "coral/x"


def test_asking_for_an_unconfigured_provider_without_a_fallback_still_refuses(tmp_path):
    d = models_dir(tmp_path, {"anthropic": ANTHROPIC})
    model, why = mc.choose(d, "anthropic/claude", "anthropic/claude", {})
    assert model is None and "ANTHROPIC_API_KEY unset" in why


def test_the_cli_prints_the_model_and_exits_zero(tmp_path):
    d = models_dir(tmp_path, {"coral": CORAL})
    env = {**os.environ, "CORALBRICKS_API_KEY": "ak_1"}
    out = subprocess.run([sys.executable, str(HERE / "model_check.py"), "--models-dir", str(d),
                          "--model", "coral/x", "--fallback", "coral/x"],
                         capture_output=True, text=True, env=env)
    assert out.returncode == 0 and out.stdout.strip() == "coral/x"


def test_the_cli_fails_loudly_with_nothing_to_run(tmp_path):
    d = models_dir(tmp_path, {"coral": CORAL})
    env = {k: v for k, v in os.environ.items() if k != "CORALBRICKS_API_KEY"}
    out = subprocess.run([sys.executable, str(HERE / "model_check.py"), "--models-dir", str(d),
                          "--model", "coral/x", "--fallback", "coral/x"],
                         capture_output=True, text=True, env=env)
    assert out.returncode == 3
    assert "CORALBRICKS_API_KEY" in out.stderr


def test_the_shipped_models_files_only_ask_for_credentials(tmp_path):
    """A harness variable sneaking into a credential position is what broke the default."""
    assert mc.credential_vars(HERE / "models" / "coral.json") == {"CORALBRICKS_API_KEY"}
    assert mc.credential_vars(HERE / "models" / "anthropic.json") == {"ANTHROPIC_API_KEY"}
    assert mc.credential_vars(HERE / "models" / "openai.json") == {"OPENAI_API_KEY"}


def test_the_sanitized_models_file_declares_every_shipped_provider():
    """An agent is handed `base/models/models.json`, not the per-provider files, so a provider
    missing from it is a model pi refuses to load. Review, cleaners and the tide all read this
    one file; `common/models/` is the list of providers that have to work."""
    catalog = json.loads((HERE.parent / "base" / "models" / "models.json").read_text())
    shipped = {path.stem for path in (HERE / "models").glob("*.json")}
    assert shipped == set(catalog["providers"]), (sorted(shipped), sorted(catalog["providers"]))
    for provider, entry in catalog["providers"].items():
        # Loopback, dummy key: the proxy is what makes the file safe to hand an agent.
        assert entry["baseUrl"].startswith("http://127.0.0.1:8787"), provider
        assert entry["apiKey"] == "$GOBY_MODEL_KEY", provider


def test_every_shipped_provider_is_one_the_shell_can_run():
    """A models file that ships but cannot be selected is a provider that never runs.

    The first scan on the GitHub path found this: `models/deepinfra.json` loaded, model_check
    accepted `deepinfra/...` because the file interpolates `$DEEPINFRA_API_KEY`, and then
    `cleaner.sh` fell into its `*)` arm and exited 2 before reading the charter. The entrypoint's
    credential case had the same hole, so the job logged a failed scan for a valid key.
    """
    for path in sorted((HERE / "models").glob("*.json")):
        provider = path.stem
        (credential,) = mc.credential_vars(path) or {None}
        assert credential, f"{path.name} interpolates no credential"
        # The scripts that switch on the provider belong to the products, not to `common/`:
        # the models files are shared, so every product must know every provider. Both of these
        # pick the upstream the proxy forwards to, so both need a `case` arm per provider.
        # `cleaner.sh` is deliberately absent: since cleaners moved onto the key proxy it holds no
        # key at all, so the provider no longer reaches the scan's process. The tide's arm lives in
        # its entrypoint for the same reason, now that it holds the key behind the proxy too.
        for script in (HERE.parent / "cleaners" / "entrypoint.sh",
                       HERE.parent / "tide" / "entrypoint.sh"):
            text = pathlib.Path(script).read_text()
            assert f"{provider})" in text, f"{script} does not know provider {provider}"
            assert credential in text, f"{script} never mentions {credential}"


BRACED = {"providers": {"openai": {"apiKey": "${OPENAI_API_KEY}",
                                   "headers": {"x-session-id": "${CLEANERS_SESSION_ID}"}}}}


def test_braced_interpolation_is_a_credential(tmp_path):
    """#44: pi's models.json interpolates `${NAME}` as well as `$NAME`. Reading only the bare form
    saw a provider with an unset key as usable, so the required fallback never ran and the scan
    failed after the clone instead of before it."""
    d = models_dir(tmp_path, {"openai": BRACED, "coral": CORAL})
    assert mc.credential_vars(d / "openai.json") == {"OPENAI_API_KEY"}
    model, why = mc.choose(d, "openai/x", "coral/x", {"CORALBRICKS_API_KEY": "k"})
    assert model == "coral/x", why
    assert mc.missing(d, "openai/x", {}) == ["OPENAI_API_KEY"]


def test_a_braced_and_a_bare_name_are_the_same_credential(tmp_path):
    d = models_dir(tmp_path, {"mixed": {"providers": {"m": {
        "apiKey": "${MIXED_KEY}", "headers": {"x-other": "$MIXED_OTHER"}}}}})
    assert mc.credential_vars(d / "mixed.json") == {"MIXED_KEY", "MIXED_OTHER"}
