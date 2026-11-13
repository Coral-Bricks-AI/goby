"""The record a review leaves behind: the agreed fields, no invented ones, and small.

The marker is posted inside a review body, so its size is a cost every reader of that pull
request pays. The bound asserted here is the one the design promised: about a kilobyte, well
under two, with the per-call array — the bulk of `timing.py`'s own output — left out because it
is already in the log.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import runrecord  # noqa: E402 — after the path line, because it imports its siblings by name


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stream(tmp_path: Path, *events: dict) -> Path:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir(exist_ok=True)
    (agent_dir / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    return agent_dir


def call(name: str, ms: int | None, **args) -> list[dict]:
    """One tool call as pi writes it: the arguments on `start`, the clock on `end`."""
    start = {"type": "tool_execution_start", "toolCallId": f"{name}-{id(args)}", "toolName": name,
             "args": args}
    end = {"type": "tool_execution_end", "toolCallId": start["toolCallId"], "toolName": name,
           "isError": False}
    if ms is not None:
        end["durationMs"] = ms
    return [start, end]


def response(ms: int, out: int = 200) -> dict:
    return {"type": "message_end", "message": {
        "role": "assistant", "durationMs": ms, "stopReason": "toolUse",
        "usage": {"input": 40, "output": out, "cacheRead": 42000, "cacheWrite": 10,
                  "reasoning": 500},
        "content": [{"type": "text", "text": "x" * 40}],
    }}


def run(tmp_path: Path, *events: dict, **kwargs) -> dict:
    return runrecord.record(stream(tmp_path, *events), **kwargs)


def test_the_record_carries_the_agreed_fields_and_nothing_else(tmp_path):
    """The field list is a promise to readers, so it is asserted rather than left to drift with
    whatever `timing.py` happens to return next."""
    record = run(tmp_path, {"type": "turn_start"}, *call("bash", 1200, command="ls"),
                 *call("read", 300, path="a.ts"), response(4000), agent_seconds=6.0,
                 model="deepseek-v4.1-flash-fast")
    assert set(record) == {
        "schema", "product", "model", "measured", "agent_s", "model_s", "tools_s", "other_s",
        "turns", "tool_calls", "tool_s", "requests", "timeouts", "blocked", "tokens", "cost",
    }
    assert record["schema"] == 1 and record["product"] == "review"
    assert record["tool_calls"] == 2 and record["turns"] == 1
    assert record["tool_s"] == {"bash": 1.2, "read": 0.3}
    assert record["requests"] == {"count": 1, "p50_s": 4.0, "p95_s": 4.0, "max_s": 4.0}


def test_token_classes_are_renamed_to_what_a_consumer_queries(tmp_path):
    record = run(tmp_path, {"type": "turn_start"}, response(1000))
    assert record["tokens"] == {"input": 40, "output": 200, "cache_read": 42000,
                                "cache_write": 10, "reasoning": 500}


def test_the_per_call_array_is_not_in_the_record(tmp_path):
    """It is the bulk of `timing.py --json` and it is already in the log. A record that carried
    it would put tens of kilobytes in every review body."""
    events = [{"type": "turn_start"}]
    for i in range(40):
        events += call("bash", 100, command=f"grep -rn 'thing {i}' src/")
    record = run(tmp_path, *events, agent_seconds=30.0, model="m")
    assert "calls" not in record
    assert record["tool_calls"] == 40
    assert len(runrecord.dump(record)) < 2048


def test_a_run_with_no_stream_is_unknown_not_zero(tmp_path):
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    record = runrecord.record(agent_dir, agent_seconds=12.0, model="m")
    assert record["measured"] is False
    assert "note" in record
    assert "cost" not in record and "tokens" not in record


def test_the_price_is_the_one_the_cost_line_prints(tmp_path):
    """One pricing function, two readers: if these disagreed, the job summary and the record
    would quote different money for the same run."""
    catalog = tmp_path / "models.json"
    catalog.write_text(json.dumps({"models": {"m": {"bill": {
        "input_cents_per_m": 1, "output_cents_per_m": 120,
        "cache_read_cents_per_m": 0, "cache_write_cents_per_m": 8}}}}))
    events = ({"type": "turn_start"}, response(1000))
    record = run(tmp_path, *events, model="m", catalog_path=catalog)
    usage = load("goby_usage_for_test", "usage.py")
    streamed = {"input": record["tokens"]["input"], "output": record["tokens"]["output"],
                "cacheRead": record["tokens"]["cache_read"],
                "cacheWrite": record["tokens"]["cache_write"]}
    expected = usage.price("m", streamed, catalog)
    assert record["cost"]["cents"] == expected["billed_cents"]
    assert record["cost"]["cents"] > 0


def test_an_unstated_rate_is_a_null_price_with_a_reason(tmp_path):
    catalog = tmp_path / "models.json"
    catalog.write_text(json.dumps({"models": {"m": {"bill": {"input_cents_per_m": 1}}}}))
    record = run(tmp_path, {"type": "turn_start"}, response(1000), model="m",
                 catalog_path=catalog)
    assert record["cost"]["cents"] is None and record["cost"]["usd"] is None
    assert "output_cents_per_m" in record["cost"]["note"]


def test_a_killed_command_is_counted_not_hidden(tmp_path):
    killed = {"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash",
              "isError": True, "durationMs": 120000,
              "result": {"content": [{"type": "text", "text": "Command timed out after 120 seconds"}]}}
    start = {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash",
             "args": {"command": "pytest"}}
    record = run(tmp_path, {"type": "turn_start"}, start, killed, response(1000),
                 agent_seconds=125.0, model="m")
    assert record["timeouts"] == 1


def test_a_tool_that_recorded_no_time_is_still_named(tmp_path):
    record = run(tmp_path, {"type": "turn_start"}, *call("bash", None, command="ls"),
                 response(1000))
    assert record["tool_s"] == {"bash": 0.0} or record["tool_calls"] == 1
    assert "bash" in record["tool_s"]


def test_the_dump_is_compact_and_stable(tmp_path):
    record = run(tmp_path, {"type": "turn_start"}, response(1000), model="m")
    text = runrecord.dump(record)
    assert text == runrecord.dump(dict(reversed(list(record.items()))))
    assert "\n" not in text and ": " not in text
