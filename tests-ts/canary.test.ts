import { describe, expect, test } from 'bun:test';
import { run_canary, statelessBodies, CANARY_TEXT_MAX } from '../src/core/canary.ts';
import type { Fetch } from '../src/providers/base.ts';

const sha = 'a'.repeat(40);
const toolCall = { type: 'function_call', name: 'read_file', call_id: 'c1', id: 'item_1', arguments: '{"path":"README.md"}' };
const answer = { type: 'message', content: [{ type: 'output_text', text: 'done' }] };

function rig(...outputs: unknown[][]) {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetch: Fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    const output = outputs[calls++];
    if (!output) throw new Error('unexpected extra model call');
    return new Response(JSON.stringify({ id: `r${calls}`, output, status: 'completed', usage: {} }));
  };
  return { bodies, fetch, get calls() { return calls; } };
}

const opts = (fetch: Fetch) => ({ api_key: 'k', model: 'm', base_url: 'https://inference.coralbricks.ai', fetch });

describe('live transport canary', () => {
  test('a tool call round-trips in a resent transcript, and every request is unpersisted', async () => {
    const r = rig([toolCall], [answer]);
    const report = await run_canary(opts(r.fetch));
    expect(report.ok).toBe(true);
    expect(report.stateless).toBe(true);
    expect(report.tool_round_trip).toBe(true);
    expect(report.turns.map(t => [t.turn, t.input_items, t.output_items])).toEqual([[1, 1, 1], [2, 4, 1]]);
    expect(report.turns[1]!.text).toBe('done');
    expect(report.error).toBeUndefined();
    // The second request is the whole transcript: the model's item and its answer.
    expect(r.bodies[1]!.input).toEqual([{ role: 'user', content: expect.any(String) }, toolCall,
      { type: 'function_call_output', call_id: 'c1', output: 'canary: file contents' },
      { role: 'user', content: expect.any(String) }]);
    for (const body of r.bodies) {
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty('previous_response_id');
      expect(body.model).toBe('m');
      expect(body.instructions).toBeUndefined(); // a canary must not need a 10k prompt
    }
  });

  test('a direct answer still proves the second turn: no tool round trip exercised', async () => {
    const r = rig([answer], [answer]);
    const report = await run_canary(opts(r.fetch));
    expect(report.ok).toBe(true);
    expect(report.tool_round_trip).toBe('not-exercised');
    expect(r.bodies[1]).not.toHaveProperty('tools');
    expect(report.turns.map(t => t.input_items)).toEqual([1, 3]);
  });

  test('a gateway that rejects the second turn fails the canary with its reason', async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      if (calls++ === 0) return new Response(JSON.stringify({ id: 'r1', output: [answer], status: 'completed', usage: {} }));
      return new Response(JSON.stringify({ error: { message: 'previous_response_id is not available for this organization', code: 'unsupported_parameter' } }), { status: 400 });
    };
    const report = await run_canary(opts(fetch));
    expect(report.ok).toBe(false);
    expect(report.turns).toHaveLength(1);
    expect(report.error).toContain('previous_response_id');
  });

  test('text is bounded and empty output fails the run', async () => {
    const long = { type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(500) }] };
    const r = rig([long], [answer]);
    const report = await run_canary(opts(r.fetch));
    expect(report.turns[0]!.text!.length).toBe(CANARY_TEXT_MAX);
    expect(report.ok).toBe(true);
    const empty = await run_canary(opts(rig([answer], []).fetch));
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('no output items');
  });

  test('statelessness is read from the wire, not assumed', () => {
    expect(statelessBodies([{ store: false }, { store: false }])).toBe(true);
    expect(statelessBodies([])).toBe(false);
    expect(statelessBodies([{ store: true }])).toBe(false);
    expect(statelessBodies([{ store: false }, { store: false, previous_response_id: 'r1' }])).toBe(false);
    expect(statelessBodies([{ model: 'm' }])).toBe(false);
  });
});
