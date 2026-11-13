#!/usr/bin/env python3
"""Sum one scan's output directory into the numbers phase 0 is supposed to produce.

    python3 usage.py /tmp/scan7 [--model deepseek-v4.1-flash-fast]

Reports tool calls, wall time, tokens, and the billed cost at the rates in a model catalog
(`bill.input_cents_per_m`, `output_cents_per_m`, `cache_read_cents_per_m`,
`cache_write_cents_per_m`), so a scan's price is quoted from the same table the customer is
charged from rather than from a guess.

The catalog is whichever of these exists first: `--models-json`, `$GOBY_MODELS_JSON`,
`$CLEANERS_MODELS_JSON` (the name the cleaner shipped with), then `.goby/models.json`
beside the checkout. Without one the run still reports its tokens; it reports the price as
unknown rather than inventing rates.

A run without an `events.jsonl` (a `pi --print` scan) has no token counts at all. That
is reported as unavailable, never as zero spend: a printed 0.0 reads as a measurement.

The model comes from the run's own `run.json` when present, because pricing the
`s-flash` tokens at the `-fast` rate would understate the cheaper model's cost and
overstate the dearer one's.
"""
import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "deepseek-v4.1-flash-fast"
DEFAULT_CATALOG = REPO / ".goby" / "models.json"


def catalog(explicit=None) -> Path | None:
    """The model catalog to price from, or None when this checkout has none.

    A consuming repo has no `.goby/models.json`, and a price is only worth printing
    when it comes from a table somebody actually bills from — so a missing catalog is a
    reported unknown, never a default rate.
    """
    for candidate in (explicit, os.environ.get("GOBY_MODELS_JSON"),
                      os.environ.get("CLEANERS_MODELS_JSON"), DEFAULT_CATALOG):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


def rate_for(model: str, path=None) -> dict | None:
    """Billing rates for a model, whether or not it carries a `provider/` prefix.

    `run.json` stores the model as it was passed on the command line (`coral/...`), while the
    catalog is keyed by bare id, public slug and aliases; comparing those directly reported
    "no bill rates" for the default model. The full name is tried first, because some
    aliases are themselves provider-qualified (`moonshotai/Kimi-K3`) and stripping the prefix
    before the lookup lost them.
    """
    catalog_path = catalog(path)
    if catalog_path is None:
        return None
    models = json.loads(catalog_path.read_text())["models"]
    bare = model.split("/", 1)[1] if "/" in model else model
    for candidate in dict.fromkeys([model, bare]):
        for name, row in models.items():
            if candidate in (name, row.get("public_slug"), *(row.get("aliases") or [])):
                return row
    return None


def price(model: str, tokens: dict | None, catalog_path=None) -> dict:
    """The bill for one run's tokens, or an unknown with the reason it is unknown.

    One function because two readers ask the same question: this script prints a scan's price
    line, and `runrecord.py` puts the same number in the marker a review leaves behind. A rate
    the catalog does not state is not a rate of zero — billing a campaign of cache-read tokens
    at an invented zero is how a printed total becomes a wrong measurement — so a token class
    with usage and no stated rate makes the price unknown and names the missing field. A stated
    `0` is a decision and is used as one.
    """
    priced = {"billed_cents": None, "billed_usd": None, "note": None}
    if tokens is None:
        priced["note"] = (
            "no events.jsonl: this scan ran without CLEANERS_JSON=1, so tokens and cost "
            "are unknown. Spend for it has to come from inference_requests."
        )
        return priced
    bill = (rate_for(model, catalog_path) or {}).get("bill")
    if not bill:
        found = catalog(catalog_path)
        priced["note"] = (f"no bill rates for {model!r} in {found}" if found else
                          "no model catalog: price unknown")
        return priced
    rate_field = {"input": "input_cents_per_m", "output": "output_cents_per_m",
                  "cacheRead": "cache_read_cents_per_m",
                  "cacheWrite": "cache_write_cents_per_m"}
    # Only the priced classes: `reasoning` is a slice of `output` that pi reports separately, and
    # a catalog has no rate for it because it is already paid for as output.
    unstated = sorted(field for name, field in rate_field.items()
                      if tokens.get(name) and field not in bill)
    if unstated:
        priced["note"] = (f"{', '.join(unstated)} not stated for {model!r}: those tokens "
                          f"would be priced at an invented zero")
        return priced
    # Bill rates are cents per million tokens, so this is cents; /100 gives USD.
    # pi reports the prompt as cacheRead/cacheWrite, so cache_read is where most
    # the prompt lands; pricing it at 0 would understate every scan.
    cents = (tokens.get("input", 0) * bill["input_cents_per_m"]
             + tokens.get("output", 0) * bill["output_cents_per_m"]
             + tokens.get("cacheRead", 0) * bill["cache_read_cents_per_m"]
             + tokens.get("cacheWrite", 0) * bill["cache_write_cents_per_m"]) / 1e6
    priced["billed_cents"] = round(cents, 2)
    priced["billed_usd"] = round(cents / 100, 4)
    return priced


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--model", default=None, help="overrides run.json")
    ap.add_argument("--models-json", default=None,
                    help="model catalog to price from; default $CLEANERS_MODELS_JSON")
    ap.add_argument("--markdown", action="store_true",
                    help="one markdown line for $GITHUB_STEP_SUMMARY instead of JSON")
    args = ap.parse_args(argv)

    events = args.out_dir / "events.jsonl"
    run = {}
    if (args.out_dir / "run.json").is_file():
        run = json.loads((args.out_dir / "run.json").read_text())
    model = args.model or run.get("model") or DEFAULT_MODEL

    tool_calls: list[str] = []
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    turns = 0
    if events.is_file():
        for line in events.read_text(errors="ignore").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "tool_execution_start":
                tool_calls.append(ev.get("toolName") or ev.get("name") or "?")
            elif t == "turn_start":
                turns += 1
            elif t == "message_end":
                u = (ev.get("message") or {}).get("usage") or {}
                for k in usage:
                    usage[k] += u.get(k) or 0

    if not events.is_file():
        usage = None  # unknown, not zero
    # The subject is whatever the run called itself: a cleaner scans a `component`, a tide one
    # measured `path`. Reading only `component` printed "`?`" on every tide line, which is the one
    # thing a cost line must not do — hide which work it paid for.
    subject = run.get("component") or run.get("path")
    # `findings` is the cleaner's word. A tide produces `proposals`, and counting only findings
    # reported "0 findings" for a run that filed one, so the count follows the record files that
    # are actually there.
    records, label = 0, "findings"
    for name, word in (("findings.jsonl", "findings"), ("proposals.jsonl", "proposals")):
        path = args.out_dir / name
        if path.is_file():
            records += sum(1 for _ in open(path))
            label = word
    summary = {
        "component": subject,
        "model": model,
        "turns": turns,
        "tool_calls": len(tool_calls),
        "tool_histogram": {n: tool_calls.count(n) for n in sorted(set(tool_calls))},
        "tokens": usage,
        "findings": records,
        "records_label": label,
        "wall_s": run.get("wall_s"),
    }

    summary.update(price(model, usage, args.models_json))

    if args.markdown:
        print(markdown(summary))
    else:
        print(json.dumps(summary, indent=2))
    return 0


def markdown(summary: dict) -> str:
    """One line for the Actions job summary: what this scan cost is the product's whole
    argument, so it belongs where a user is already looking."""
    def money(value):
        return "price unknown" if value is None else f"${value:.4f}"

    parts = [f"`{summary.get('component') or '?'}`", str(summary.get("model") or "?")]
    if summary.get("turns") is not None:
        parts.append(f"{summary['turns']} turns")
    parts.append(f"{summary.get('tool_calls', 0)} tool calls")
    if summary.get("wall_s") is not None:
        parts.append(f"{summary['wall_s']} s")
    parts.append(f"{summary.get('findings', 0)} {summary.get('records_label') or 'findings'}")
    parts.append(money(summary.get("billed_usd")))
    return "- " + " · ".join(parts)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
