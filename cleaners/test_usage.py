"""Tests for the local cost report: a provider-qualified model must still be priced."""
import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("coral_cleaners_usage", HERE / "usage.py")
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)

# These four check our own price table against our own catalog, which only exists in the
# repo that has `ml/platform/models.json`. A consuming repo has no such file and must not
# fail on its absence; the logic below is covered without a catalog by the fixture test.
catalog_only = pytest.mark.skipif(usage.catalog() is None,
                                  reason="no model catalog in this checkout")


@catalog_only
def test_a_provider_prefixed_model_is_priced():
    """`run.json` stores what was passed (`coral/…`); the catalog is keyed by bare id. Without
    stripping the prefix the default hunt reported "no bill rates"."""
    row = usage.rate_for("coral/deepseek-v4.1-flash-fast")
    assert row is not None and (row.get("bill") or {}).get("input_cents_per_m") is not None


@catalog_only
def test_a_bare_model_is_still_priced():
    assert usage.rate_for("deepseek-v4.1-flash-fast") is not None


@catalog_only
def test_an_unknown_model_has_no_rates_rather_than_guessed_ones():
    assert usage.rate_for("coral/does-not-exist") is None
    assert usage.rate_for("anthropic/claude-sonnet-5") is None


@catalog_only
def test_a_provider_qualified_alias_keeps_its_rates():
    """Some catalog aliases are themselves provider-qualified (`moonshotai/Kimi-K3`), so the
    full name has to be tried before the prefix is stripped."""
    row = usage.rate_for("moonshotai/Kimi-K3")
    assert row is not None
    assert "moonshotai/Kimi-K3" in (row.get("aliases") or [])


def write_catalog(tmp_path: Path) -> Path:
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"models": {
        "test-model-1": {"bill": {"input_cents_per_m": 10, "output_cents_per_m": 20},
                         "aliases": ["vendor/test-model-1"]},
    }}))
    return path


def test_a_catalog_can_be_given_explicitly(tmp_path):
    """A consuming repo points at its own rates; the default layout is not required."""
    path = write_catalog(tmp_path)
    assert usage.catalog(str(path)) == path
    row = usage.rate_for("coral/test-model-1", path)
    assert row["bill"]["input_cents_per_m"] == 10
    assert usage.rate_for("vendor/test-model-1", path) == row
    assert usage.rate_for("coral/nope", path) is None


def test_a_catalog_can_come_from_the_environment(tmp_path, monkeypatch):
    path = write_catalog(tmp_path)
    monkeypatch.setenv("CLEANERS_MODELS_JSON", str(path))
    assert usage.catalog() == path
    assert usage.rate_for("coral/test-model-1") is not None


def test_without_a_catalog_the_price_is_unknown_not_zero(tmp_path, monkeypatch):
    """No catalog means no rate: a printed 0.00 reads as a measurement somebody made."""
    monkeypatch.delenv("CLEANERS_MODELS_JSON", raising=False)
    monkeypatch.setattr(usage, "DEFAULT_CATALOG", tmp_path / "absent.json")
    assert usage.catalog() is None
    assert usage.rate_for("coral/deepseek-v4.1-flash-fast") is None


def test_the_summary_line_names_the_price_and_the_findings():
    line = usage.markdown({"component": "gateway/dispatch", "model": "coral/x", "turns": 7,
                           "tool_calls": 42, "wall_s": 95, "findings": 1,
                           "billed_usd": 0.0213})
    assert line.startswith("- `gateway/dispatch` · coral/x · 7 turns · 42 tool calls")
    assert line.endswith("1 findings · $0.0213")


def test_the_summary_line_says_unknown_rather_than_printing_a_zero():
    line = usage.markdown({"component": "c", "model": "m", "tool_calls": 0,
                           "findings": 0, "billed_usd": None})
    assert "price unknown" in line


def hunt_dir(tmp_path, usage_tokens, model="coral/test-model-1"):
    (tmp_path / "run.json").write_text(json.dumps({"component": "c", "model": model}))
    (tmp_path / "events.jsonl").write_text(json.dumps(
        {"type": "message_end", "message": {"usage": usage_tokens}}) + "\n")
    return tmp_path


def test_an_unstated_rate_makes_the_price_unknown_not_zero(tmp_path, capsys):
    """A rate the catalog omits is not a rate of zero. Pricing cache-read tokens at an invented
    zero produced a confident total for a hunt whose prompt is mostly cache reads."""
    catalog_path = tmp_path / "models.json"
    catalog_path.write_text(json.dumps({"models": {"test-model-1": {"bill": {
        "input_cents_per_m": 1, "output_cents_per_m": 120, "cache_write_cents_per_m": 8}}}}))
    out = hunt_dir(tmp_path, {"input": 10, "output": 1000, "cacheRead": 500000, "cacheWrite": 0})
    assert usage.main([str(out), "--models-json", str(catalog_path)]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["billed_usd"] is None
    assert "cache_read_cents_per_m not stated" in summary["note"]
    assert "invented zero" in summary["note"]


def test_a_stated_zero_rate_is_used_as_a_decision(tmp_path, capsys):
    """The same totals price cleanly once the catalog says the rate is zero."""
    catalog_path = tmp_path / "models.json"
    catalog_path.write_text(json.dumps({"models": {"test-model-1": {"bill": {
        "input_cents_per_m": 1, "output_cents_per_m": 120,
        "cache_read_cents_per_m": 0, "cache_write_cents_per_m": 8}}}}))
    out = hunt_dir(tmp_path, {"input": 10, "output": 1000, "cacheRead": 500000, "cacheWrite": 0})
    assert usage.main([str(out), "--models-json", str(catalog_path)]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["billed_usd"] == 0.0012  # (10*1 + 1000*120) / 1e6 cents


def test_our_own_rates_file_prices_the_default_model(tmp_path, capsys):
    """`.coral/models.json` is what the entrypoint adopts; if it stops matching the default
    model name, every hunt silently goes back to "price unknown"."""
    path = Path(__file__).resolve().parents[1] / ".coral" / "models.json"
    if not path.is_file():
        pytest.skip("this checkout has no committed rates file")
    out = hunt_dir(tmp_path, {"input": 1, "output": 1, "cacheRead": 1, "cacheWrite": 1},
                   model="coral/deepseek-v4.1-flash-fast")
    assert usage.main([str(out), "--models-json", str(path)]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["billed_usd"] is not None, summary.get("note")
