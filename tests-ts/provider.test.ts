import { describe, expect, spyOn, test } from "bun:test";
import {
  call_model, call_responses, extract_function_calls, extract_text, GatewayError,
  type Fetch,
} from "../src/providers/base.ts";
import { CORAL, OPENAI, PROVIDERS, resolve_provider } from "../src/providers/index.ts";

const chat = (usage: unknown = {}) => new Response(JSON.stringify({
  choices: [{ message: { content: "[]" } }], usage,
}));
const turn = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: "r", output: [], status: "completed", usage: {}, ...extra,
}));
const http_error = (status: number, code: unknown = "internal_error") =>
  new Response(JSON.stringify({ error: { code } }), { status });
const model_opts = { api_key: "k", model: "m", system: "s", user: "u" };
const response_opts = { api_key: "k", model: "m", input: "hi" };

type Step = Response | Error | (() => Response | Promise<Response>);
function rig(...steps: Step[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const clock = { now: 1000, oversleep: 0 };
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error("unexpected fetch");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? await step() : step;
  };
  const opts = {
    fetch,
    clock: () => clock.now,
    sleep: async (s: number) => { sleeps.push(s); clock.now += s + clock.oversleep; },
  };
  return { seen, sleeps, clock, opts };
}

async function gateway_error(promise: Promise<unknown>, code: number): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gateway = error as GatewayError;
    expect(gateway.code).toBe(code);
    expect(gateway.body).toBe(gateway.details);
    return gateway;
  }
  throw new Error("expected GatewayError");
}

async function capture_timeouts(run: (timeouts: number[]) => Promise<void>) {
  const timeouts: number[] = [];
  const original = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timeouts.push(timeout ?? 0);
    return original(handler, timeout, ...args);
  }) as typeof setTimeout);
  try { await run(timeouts); } finally { spy.mockRestore(); }
}

describe("request and return contract", () => {
  test("chat payload, headers, default timeout and snake_case reply", async () => {
    await capture_timeouts(async timeouts => {
      const r = rig(() => { r.clock.now += 2; return chat({ prompt_tokens: "12", completion_tokens: 4.9 }); });
      const reply = await call_model({ ...model_opts, ...r.opts, base_url: "https://unit.invalid///", session_id: "review", temperature: 0.2 });
      expect(reply).toEqual({ content: "[]", elapsed_s: 2, prompt_tokens: 12, completion_tokens: 4 });
      expect(timeouts).toEqual([180000]);
      expect(r.seen[0]!.url).toBe("https://unit.invalid/v1/chat/completions");
      expect(r.seen[0]!.init.method).toBe("POST");
      const headers = new Headers(r.seen[0]!.init.headers);
      expect(headers.get("Authorization")).toBe("Bearer k");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("x-session-id")).toBe("review");
      expect(headers.has("idempotency-key")).toBe(false); // No invented idempotency policy.
      expect(JSON.parse(r.seen[0]!.init.body as string)).toEqual({
        model: "m", temperature: 0.2,
        messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      });
    });
  });

  test("responses replays the transcript statelessly, with instructions and store:false", async () => {
    const output = [{ type: "reasoning", summary: [] }];
    const r = rig(turn({ output, usage: { input_tokens: "7", output_tokens: 0 }, status: "incomplete" }), turn());
    const opts = { ...response_opts, ...r.opts, instructions: "contract", tools: [{ type: "function", name: "read" }], session_id: "s" };
    const reply = await call_responses(opts);
    // A gateway under zero data retention has no stored turn to continue, so
    // the caller resends the whole conversation instead of previous_response_id.
    const transcript = [{ role: "user", content: "hi" }, ...output, { type: "function_call_output", output: "ok" }];
    await call_responses({ ...opts, input: transcript });
    expect(reply).toEqual({ id: "r", output, elapsed_s: 0, input_tokens: 7, output_tokens: 0, status: "incomplete" });
    for (const request of r.seen) {
      expect(request.url).toBe("https://inference.coralbricks.ai/v1/responses");
      expect(JSON.parse(request.init.body as string)).toMatchObject({
        model: "m", temperature: 0, instructions: "contract", tool_choice: "auto", tools: opts.tools, store: false,
      });
      expect(JSON.parse(request.init.body as string)).not.toHaveProperty("previous_response_id");
    }
    expect(JSON.parse(r.seen[1]!.init.body as string).input).toEqual(transcript);
  });

  test("empty optional fields omitted, absent and null token usage default to zero", async () => {
    await capture_timeouts(async timeouts => {
      const r = rig(new Response("{}"), chat(null));
      const reply = await call_responses({ ...response_opts, ...r.opts, instructions: "", tools: [], session_id: "" });
      expect(reply).toEqual({ id: "", output: [], elapsed_s: 0, input_tokens: 0, output_tokens: 0, status: "" });
      expect(JSON.parse(r.seen[0]!.init.body as string)).toEqual({ model: "m", input: "hi", temperature: 0, store: false });
      expect(new Headers(r.seen[0]!.init.headers).has("x-session-id")).toBe(false);
      expect((await call_model({ ...model_opts, ...r.opts })).prompt_tokens).toBe(0);
      expect(timeouts).toEqual([300000, 180000]);
    });
  });

  test("token conversion follows int semantics for common JSON values", async () => {
    for (const [value, expected] of [[null, 0], ["", 0], [false, 0], [true, 1], [" -2 ", -2], [3.9, 3]] as const) {
      const r = rig(turn({ usage: { input_tokens: value, output_tokens: value } }));
      expect((await call_responses({ ...response_opts, ...r.opts })).input_tokens).toBe(expected);
    }
  });

  test("full body is read (no size cap), details remain untruncated", async () => {
    const text = "x".repeat(100000);
    const r = rig(new Response(JSON.stringify({ choices: [{ message: { content: text } }] })), new Response(text, { status: 400 }));
    expect((await call_model({ ...model_opts, ...r.opts })).content).toBe(text);
    const error = await gateway_error(call_responses({ ...response_opts, ...r.opts }), 400);
    expect(error.details).toBe(text);
    expect(error.message).toBe(`gateway HTTP 400: ${text.slice(0, 500)}`);
  });
});

describe("one safe retry only", () => {
  for (const failure of ["network", 502, 503] as const) {
    test(`${failure} retries with a fresh request and elapsed backoff`, async () => {
      const r = rig(failure === "network" ? new TypeError("connection reset") : http_error(failure), chat());
      const reply = await call_model({ ...model_opts, ...r.opts });
      expect(reply.elapsed_s).toBe(3);
      expect(r.sleeps).toEqual([3]);
      expect(r.seen).toHaveLength(2);
      expect(r.seen[0]!.init).not.toBe(r.seen[1]!.init);
      expect(r.seen[0]!.init.signal).not.toBe(r.seen[1]!.init.signal);
      expect(r.seen[0]!.init.body).toBe(r.seen[1]!.init.body);
    });
  }

  test("network and HTTP failures share one retry allowance", async () => {
    for (const failures of [[new TypeError("reset"), http_error(502)], [http_error(503), new TypeError("reset")]]) {
      const r = rig(...failures);
      await gateway_error(call_responses({ ...response_opts, ...r.opts }), failures[1] instanceof Response ? 502 : 0);
      expect(r.seen).toHaveLength(2);
      expect(r.sleeps).toEqual([3]);
    }
  });

  for (const status of [400, 401, 404, 429, 500, 504]) {
    test(`HTTP ${status} is never retried`, async () => {
      const r = rig(http_error(status));
      await gateway_error(call_model({ ...model_opts, ...r.opts }), status);
      expect(r.seen).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    });
  }

  test("named post-execution errors are never replayed", async () => {
    for (const status of [502, 503]) {
      const r = rig(http_error(status, "upstream_stream_incomplete"));
      const error = await gateway_error(call_responses({ ...response_opts, ...r.opts }), status);
      expect(error.details).toContain("upstream_stream_incomplete");
      expect(r.seen).toHaveLength(1);
    }
  });

  test("malformed error envelopes remain retryable", async () => {
    for (const text of ["junk", "null", '{"error":null}', '{"error":{"code":["internal_error"]}}', '{"error":{"code":{}}}']) {
      const r = rig(new Response(text, { status: 502 }), turn());
      expect((await call_responses({ ...response_opts, ...r.opts })).id).toBe("r");
      expect(r.seen).toHaveLength(2);
    }
  });
});

describe("monotonic retry deadline and timeouts", () => {
  test("first call retains allowance, retry shrinks including failure and backoff time", async () => {
    await capture_timeouts(async timeouts => {
      const r = rig(() => { r.clock.now += 4; throw new TypeError("reset"); }, turn());
      r.clock.oversleep = 2;
      const reply = await call_responses({ ...response_opts, ...r.opts, timeout_s: 300, deadline_s: 1030 });
      expect(timeouts).toEqual([300000, 21000]);
      expect(reply.elapsed_s).toBe(9);
    });
  });

  test("retry never expands an initially shorter timeout", async () => {
    await capture_timeouts(async timeouts => {
      const r = rig(http_error(503), turn());
      await call_responses({ ...response_opts, ...r.opts, timeout_s: 2, deadline_s: 1100 });
      expect(timeouts).toEqual([2000, 2000]);
    });
  });

  test("expired deadline still permits first call", async () => {
    const r = rig(turn());
    expect((await call_responses({ ...response_opts, ...r.opts, deadline_s: 999 })).id).toBe("r");
    expect(r.seen).toHaveLength(1);
  });

  test("no retry or sleep at the one-second budget floor", async () => {
    for (const failure of [new TypeError("reset"), http_error(502)]) {
      const r = rig(failure);
      const error = await gateway_error(call_responses({ ...response_opts, ...r.opts, deadline_s: 1004 }), failure instanceof Response ? 502 : 0);
      expect(error.details).toContain("no retry budget left (1.0s)");
      expect(r.seen).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    }
  });

  test("scheduler oversleep cannot start an out-of-budget retry", async () => {
    const r = rig(new TypeError("reset"));
    r.clock.oversleep = 12;
    const error = await gateway_error(call_responses({ ...response_opts, ...r.opts, deadline_s: 1010 }), 0);
    expect(error.details).toContain("retry backoff consumed");
    expect(r.seen).toHaveLength(1);
  });

  test("fetch timeout/abort and wrapped undici timeout never retry", async () => {
    for (const error of [new DOMException("timeout", "TimeoutError"), new DOMException("abort", "AbortError"), new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })]) {
      const r = rig(error);
      await gateway_error(call_model({ ...model_opts, ...r.opts }), 0);
      expect(r.seen).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    }
  });

  for (const stage of ["headers", "body"]) {
    test(`own timeout cancels a hanging ${stage} without replay`, async () => {
      // Fire the timeout in a microtask: no wall-clock wait or network dependency.
      const original = globalThis.setTimeout;
      const spy = spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) => {
        queueMicrotask(() => handler(...args));
        return original(() => {}, 60000);
      }) as typeof setTimeout);
      let signal: AbortSignal | undefined;
      let calls = 0;
      const fetch: Fetch = async (_url, init) => {
        calls++;
        signal = init.signal!;
        if (stage === "headers") return await new Promise<Response>(() => {});
        return { ok: true, status: 200, text: () => new Promise<string>(() => {}) } as Response;
      };
      try {
        const error = await gateway_error(call_responses({ ...response_opts, fetch, timeout_s: 1 }), 0);
        expect(error.details).toBe("timed out");
        expect(signal?.aborted).toBe(true);
        expect(calls).toBe(1);
      } finally { spy.mockRestore(); }
    });
  }
});

describe("malformed replies are terminal", () => {
  test("invalid JSON, shape, content and usage are GatewayError(200)", async () => {
    const bad_chat = ["not JSON", "null", "[]", "{}", '{"choices":[]}', '{"choices":[{"message":{"content":null}}]}', '{"choices":[{"message":{"content":[]}}]}'];
    for (const text of bad_chat) {
      const r = rig(new Response(text));
      await gateway_error(call_model({ ...model_opts, ...r.opts }), 200);
      expect(r.seen).toHaveLength(1);
    }
    for (const extra of [{ output: "oops" }, { usage: "oops" }, { usage: { input_tokens: "1.5" } }, { usage: { output_tokens: { invalid: true } } }]) {
      const r = rig(turn(extra));
      await gateway_error(call_responses({ ...response_opts, ...r.opts }), 200);
      expect(r.seen).toHaveLength(1);
    }
    const r = rig(turn({ output: { invalid: true } }));
    await gateway_error(call_responses({ ...response_opts, ...r.opts }), 200);
  });

  test("body read failure cannot safely replay an executed request", async () => {
    const response = turn();
    response.text = async () => { throw new TypeError("connection closed during body"); };
    const r = rig(response);
    await gateway_error(call_responses({ ...response_opts, ...r.opts }), 200);
    expect(r.seen).toHaveLength(1);
  });
});

describe("extractors", () => {
  test("ignores reasoning and non-object items and joins output_text in order", () => {
    const items = [null, 1, [], { type: "reasoning" }, { type: "message", content: [null, { type: "refusal", text: "no" }, { type: "output_text", text: "one" }, { type: "output_text", text: "" }] }, { type: "message", content: [{ type: "output_text", text: "two" }] }];
    expect(extract_text(items)).toBe("one\ntwo");
  });

  test("distinguishes no output_text from present-but-empty parts", () => {
    for (const items of [[], [{ type: "function_call" }], [{ type: "message" }], [{ type: "message", content: [] }]]) {
      expect(extract_text(items)).toBeNull();
    }
    for (const part of [{ type: "output_text" }, { type: "output_text", text: "" }, { type: "output_text", text: null }]) {
      expect(extract_text([{ type: "message", content: [part] }])).toBe("");
    }
    expect(() => extract_text([{ type: "message", content: [{ type: "output_text", text: 5 }] }])).toThrow(TypeError);
  });

  test("function calls retain identity, raw arguments and order", () => {
    const a = { type: "function_call", arguments: "not JSON" };
    const b = { type: "function_call", call_id: "b" };
    const calls = extract_function_calls([null, [], "function_call", a, { type: "message" }, b]);
    expect(calls).toEqual([a, b]);
    expect(calls[0]).toBe(a);
    expect(extract_function_calls([])).toEqual([]);
  });
});

describe("provider registry", () => {
  test("canonical models, URLs and key variables", () => {
    expect(CORAL).toEqual({ name: "coral", base_url: "https://inference.coralbricks.ai", api_key_env: "CORALBRICKS_API_KEY", default_model: "deepseek-v4.1-flash-fast", supports_responses: true });
    expect(OPENAI).toEqual({ name: "openai", base_url: "https://api.openai.com", api_key_env: "OPENAI_API_KEY", default_model: process.env.GOBY_MODEL ?? "gpt-4.1", supports_responses: true });
    expect(PROVIDERS.coral).toBe(CORAL);
    expect(resolve_provider(undefined, {})).toBe(CORAL);
    expect(resolve_provider(" CoRaL ", { GOBY_PROVIDER: "openai" })).toBe(CORAL);
    expect(resolve_provider(undefined, { GOBY_PROVIDER: "OPENAI", GOBY_MODEL: "custom" }).default_model).toBe("custom");
    expect(resolve_provider("openai", {}).default_model).toBe("gpt-4.1");
    expect(resolve_provider("openai", { GOBY_MODEL: "" }).default_model).toBe("");
  });

  test("unknown and whitespace names fail, including prototype keys", () => {
    for (const name of [" ", "unknown", "constructor", "__proto__"]) {
      expect(() => resolve_provider(name, {})).toThrow("known providers: coral, openai");
    }
  });
});
