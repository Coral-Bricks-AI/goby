/** One HTTP turn, with the same bounded retry policy as goby.providers.base. */
export const DEFAULT_BASE_URL = "https://inference.coralbricks.ai";

export class GatewayError extends Error {
  readonly body: string;

  constructor(readonly code: number, readonly details: string) {
    super(`gateway HTTP ${code}: ${details.slice(0, 500)}`);
    this.name = "GatewayError";
    this.body = details; // Python compatibility; details is the public TS spelling.
  }
}

export interface ModelReply {
  content: string;
  elapsed_s: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ResponsesTurn {
  id: string;
  output: unknown[];
  elapsed_s: number;
  input_tokens: number;
  output_tokens: number;
  status: string;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  api_key: string;
  model: string;
  base_url?: string;
  session_id?: string | null;
  timeout_s?: number;
  temperature?: number;
  /** Absolute monotonic seconds, in the same clock domain as clock(). Retry only. */
  deadline_s?: number | null;
  fetch?: Fetch;
  /** Monotonic seconds, not Date.now() milliseconds. */
  clock?: () => number;
  sleep?: (seconds: number) => Promise<void>;
}

export interface CallModelOptions extends TransportOptions {
  system: string;
  user: string;
}

export interface CallResponsesOptions extends TransportOptions {
  input: string | unknown[];
  instructions?: string | null;
  tools?: unknown[] | null;
  previous_response_id?: string | null;
}

type ObjectValue = Record<string, unknown>;
const is_object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// JSON's empty containers are false in Python, unlike JavaScript.
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (is_object(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function shape_error(details: string): GatewayError {
  return new GatewayError(200, `unexpected response shape: ${details}`);
}

function object(value: unknown, field: string): ObjectValue {
  if (!is_object(value)) throw shape_error(`${field} must be an object`);
  return value;
}

function tokens(value: unknown): number {
  if (!truthy(value)) return 0;
  let result: number;
  if (typeof value === "boolean") result = Number(value);
  else if (typeof value === "number") result = Math.trunc(value);
  else if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    result = Number(value.trim());
  } else throw shape_error("token count must be an integer or numeric value");
  if (!Number.isFinite(result)) throw shape_error("token count must be finite");
  return result;
}

class RequestFailure extends GatewayError {
  constructor(code: number, details: string, readonly safe_to_retry: boolean) {
    super(code, details);
  }
}

function is_timeout(error: unknown): boolean {
  // Node fetch wraps undici/socket failures in TypeError.cause.
  for (let depth = 0; error && typeof error === "object" && depth < 8; depth++) {
    const e = error as { name?: string; code?: string; cause?: unknown };
    if (e.name === "TimeoutError" || e.name === "AbortError" ||
        ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT", "ABORT_ERR"].includes(e.code ?? "")) return true;
    error = e.cause;
  }
  return false;
}

function post_execution_error(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body);
    return is_object(payload) && is_object(payload.error) &&
      payload.error.code === "upstream_stream_incomplete";
  } catch {
    return false;
  }
}

async function attempt(
  url: string, body: string, headers: Record<string, string>,
  timeout_s: number, fetch_impl: Fetch,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed_out = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestFailure(0, "timed out", false));
      controller.abort();
    }, timeout_s * 1000);
  });
  const request = async (): Promise<unknown> => {
    let response: Response;
    try {
      // Fresh init/headers/signal each attempt; never replay a consumed Request.
      response = await fetch_impl(url, {
        method: "POST", headers: { ...headers }, body, signal: controller.signal,
      });
    } catch (error) {
      throw new RequestFailure(0, String(error), !is_timeout(error));
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // Once headers arrive, a read failure cannot establish a safe replay.
      throw new RequestFailure(response.status, `response read failed: ${String(error)}`, false);
    }
    if (!response.ok) {
      throw new RequestFailure(response.status, text,
        (response.status === 502 || response.status === 503) && !post_execution_error(text));
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw shape_error(`invalid JSON: ${String(error)}`);
    }
  };
  try {
    // Covers the entire body read, not just the time until fetch returns headers.
    return await Promise.race([request(), timed_out]);
  } finally {
    clearTimeout(timer);
  }
}

async function post_json(
  opts: TransportOptions, path: string, payload: ObjectValue, default_timeout_s: number,
): Promise<{ payload: unknown; elapsed_s: number }> {
  const clock = opts.clock ?? (() => performance.now() / 1000);
  const sleep = opts.sleep ?? (seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)));
  const fetch_impl: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const start = clock();
  let timeout_s = opts.timeout_s ?? default_timeout_s;
  if (!Number.isFinite(timeout_s) || timeout_s <= 0) {
    throw new GatewayError(0, "timeout_s must be positive and finite");
  }
  const url = (opts.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "") + path;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.api_key}`, "Content-Type": "application/json",
  };
  if (opts.session_id) headers["x-session-id"] = opts.session_id;
  const body = JSON.stringify(payload);
  for (let n = 0; n < 2; n++) {
    try {
      const result = await attempt(url, body, headers, timeout_s, fetch_impl);
      return { payload: result, elapsed_s: clock() - start };
    } catch (error) {
      if (!(error instanceof RequestFailure) || !error.safe_to_retry || n === 1) throw error;
      if (opts.deadline_s != null) {
        const remaining = opts.deadline_s - clock() - 3;
        if (remaining <= 1) {
          throw new GatewayError(error.code,
            `no retry budget left (${remaining.toFixed(1)}s): ${error.details}`);
        }
        timeout_s = Math.min(timeout_s, remaining);
      }
      await sleep(3);
      if (opts.deadline_s != null) {
        const left = opts.deadline_s - clock();
        if (left <= 0) {
          throw new GatewayError(error.code,
            `retry backoff consumed the remaining budget (${left.toFixed(1)}s): ${error.details}`);
        }
        timeout_s = Math.min(timeout_s, left);
      }
    }
  }
  throw new Error("unreachable");
}

export async function call_model(opts: CallModelOptions): Promise<ModelReply> {
  const result = await post_json(opts, "/v1/chat/completions", {
    model: opts.model, temperature: opts.temperature ?? 0,
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
  }, 180);
  const payload = object(result.payload, "response");
  if (!Array.isArray(payload.choices) || !payload.choices.length) throw shape_error("missing choices");
  const message = object(object(payload.choices[0], "choice").message, "message");
  if (typeof message.content !== "string") throw new GatewayError(200, "non-string content");
  const usage = object(truthy(payload.usage) ? payload.usage : {}, "usage");
  return {
    content: message.content, elapsed_s: result.elapsed_s,
    prompt_tokens: tokens(usage.prompt_tokens), completion_tokens: tokens(usage.completion_tokens),
  };
}

export async function call_responses(opts: CallResponsesOptions): Promise<ResponsesTurn> {
  const body: ObjectValue = { model: opts.model, input: opts.input, temperature: opts.temperature ?? 0 };
  if (opts.instructions) body.instructions = opts.instructions;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.previous_response_id) body.previous_response_id = opts.previous_response_id;
  const result = await post_json(opts, "/v1/responses", body, 300);
  const payload = object(result.payload, "response");
  const output = truthy(payload.output) ? payload.output : [];
  if (!Array.isArray(output)) throw shape_error("output must be a list");
  const usage = object(truthy(payload.usage) ? payload.usage : {}, "usage");
  return {
    id: truthy(payload.id) ? String(payload.id) : "", output,
    elapsed_s: result.elapsed_s, input_tokens: tokens(usage.input_tokens),
    output_tokens: tokens(usage.output_tokens), status: truthy(payload.status) ? String(payload.status) : "",
  };
}

/** null means no output_text parts; present-but-empty text returns "". */
export function extract_text(items: readonly unknown[]): string | null {
  const texts: string[] = [];
  for (const item of items) {
    if (!is_object(item) || item.type !== "message") continue;
    const content = truthy(item.content) ? item.content : [];
    if (!Array.isArray(content)) throw new TypeError("message content must be a list");
    for (const part of content) {
      if (!is_object(part) || part.type !== "output_text") continue;
      const text = part.text === undefined ? "" : part.text;
      if (!truthy(text)) texts.push("");
      else if (typeof text === "string") texts.push(text);
      else throw new TypeError("output_text text must be a string");
    }
  }
  return texts.length ? texts.filter(Boolean).join("\n") : null;
}

/** Preserve the original items and order; do not parse tool arguments here. */
export function extract_function_calls(items: readonly unknown[]): ObjectValue[] {
  return items.filter((item): item is ObjectValue => is_object(item) && item.type === "function_call");
}
