/** A live transport canary: does a real multi-turn, stateless loop work here?
 *
 * The review loop survives on one property that no offline test can prove: the
 * configured gateway and key accept a second turn whose conversation is resent
 * in `input`. An organization with zero data retention rejects
 * `previous_response_id`, so a review that stops passing this canary cannot run
 * at all — and the failure mode is silent per PR until someone reads a log.
 * `goby doctor --deep` runs this against the real endpoint.
 */
import { TOOLS } from './agent.ts';
import { call_responses, extract_function_calls, extract_text,
  type Fetch, type ResponsesTurn } from '../providers/base.ts';

export interface CanaryStep {
  turn: number;
  input_items: number;
  output_items: number;
  status: string;
  elapsed_s: number;
  text?: string;
}

export interface CanaryReport {
  ok: boolean;
  endpoint: string;
  model: string;
  /** Every request carried store:false and none carried previous_response_id. */
  stateless: boolean;
  /** true: a tool call round-tripped; 'not-exercised': the model answered directly. */
  tool_round_trip: boolean | 'not-exercised';
  turns: CanaryStep[];
  error?: string;
}

export interface CanaryOptions {
  api_key: string;
  model: string;
  base_url: string;
  timeout_s?: number;
  fetch?: Fetch;
}

const ASK = 'Call read_file for path "README.md" with the tool, then reply with exactly: done';
const FOLLOW_UP = 'Reply with exactly: done';
export const CANARY_TEXT_MAX = 120;

function step(turn: number, reply: ResponsesTurn, input_items: number): CanaryStep {
  const text = extract_text(reply.output);
  return { turn, input_items, output_items: reply.output.length, status: reply.status,
    elapsed_s: Number(reply.elapsed_s.toFixed(3)), ...(text ? { text: text.slice(0, CANARY_TEXT_MAX) } : {}) };
}

/** True only when every captured request was stateless and unpersisted. */
export function statelessBodies(bodies: readonly Record<string, unknown>[]): boolean {
  return bodies.length > 0 && bodies.every(body => body.store === false && !('previous_response_id' in body));
}

export async function run_canary(opts: CanaryOptions): Promise<CanaryReport> {
  const bodies: Record<string, unknown>[] = [];
  const send = opts.fetch ?? globalThis.fetch;
  // Inspect the exact body the transport sends; that is the regression surface.
  const fetch: Fetch = async (url, init) => {
    try { bodies.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>); } catch { bodies.push({}); }
    return send(url, init);
  };
  const shared = { api_key: opts.api_key, model: opts.model, base_url: opts.base_url,
    timeout_s: opts.timeout_s ?? 120, fetch };
  const report: CanaryReport = { ok: false, endpoint: opts.base_url, model: opts.model,
    stateless: false, tool_round_trip: 'not-exercised', turns: [] };
  try {
    const prompt = { role: 'user', content: ASK };
    const first = await call_responses({ ...shared, input: [prompt], tools: TOOLS });
    report.turns.push(step(1, first, 1));
    // Answer the tool call, if any, in the same resent transcript — prompt
    // included, exactly as the review loop replays it.
    const calls = extract_function_calls(first.output);
    const next: unknown[] = [prompt, ...first.output];
    for (const fc of calls) next.push({ type: 'function_call_output', call_id: fc.call_id || fc.id || '', output: 'canary: file contents' });
    if (calls.length) report.tool_round_trip = true;
    next.push({ role: 'user', content: FOLLOW_UP });
    const second = await call_responses({ ...shared, input: next, tools: calls.length ? TOOLS : null });
    report.turns.push(step(2, second, next.length));
    report.stateless = statelessBodies(bodies);
    if (!report.stateless) report.error = 'requests were not stateless (store:false, no previous_response_id)';
    else if (report.turns.some(t => t.output_items === 0)) report.error = 'a turn returned no output items';
    else report.ok = true;
  } catch (e) {
    report.stateless = statelessBodies(bodies);
    report.error = e instanceof Error ? e.message : String(e);
  }
  return report;
}
