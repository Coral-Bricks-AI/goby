import {describe, expect, test} from 'bun:test';
import {GitHubClient, type ThreadRecord} from '../src/platforms/github.ts';
import {review, type ReviewOptions} from '../src/core/review.ts';
import {refreshGate} from '../src/core/gate.ts';
import {parseReceipt, evaluateGate, diffDigest, receiptMarker, type ReviewReceipt} from '../src/core/verdict.ts';
import type {AgentReply} from '../src/core/agent.ts';

const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const DIFF = 'diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1 +1 @@\n-return total\n+return total - 1\n';
const bug = (severity = 'high', line = 1) => ({path: 'calc.py', line, severity, title: 'Wrong result', detail: 'The returned total is reduced by one.'});
function receipt(patch: Partial<ReviewReceipt> = {}): ReviewReceipt {
  return {schema: 2, head_sha: HEAD, base_ref: 'main', diff_sha256: diffDigest(DIFF), complete: true, agent: true, unthreaded: 0, finding_ids: [], ...patch};
}
function harness() {
  const h = {head: HEAD, base: 'main', diff: DIFF, content: '[]', exhausted: false, truncated: false, fallback: false, complete: true,
    rows: [] as Record<string, unknown>[], threads: [] as ThreadRecord[], statuses: [] as Record<string, unknown>[], modelCalls: 0,
    nextExecution: null as string | null, readError: false, moveDuringModel: false};
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).pathname;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (path.includes('/statuses/')) { h.statuses.push(body); return Response.json(body); }
      if (path.endsWith('/reviews')) {
        if (h.fallback && body.comments.length) return Response.json({message: 'bad line'}, {status: 422});
        const row = {id: h.rows.length + 1, commit_id: body.commit_id, body: body.body, state: 'COMMENTED', user: {login: 'github-actions[bot]'}};
        h.rows.push(row);
        for (const c of body.comments) {
          const fid = /id=(\w+)/.exec(c.body)?.[1] ?? '';
          h.threads.push({thread_id: `T${h.threads.length}`, comment_id: h.threads.length + 1, path: 'calc.py', line: 1,
            start_line: null, original_line: 1, original_start_line: null, marker_start: null, marker_end: null,
            sha: HEAD.slice(0, 10), outdated: false, created_at: '2026-01-01', title: 'Wrong result', fid, resolved: false});
        }
        return Response.json(row);
      }
    }
    if (path.endsWith('/reviews')) return Response.json(h.rows);
    throw new Error(`Unexpected test network call ${path}`);
  }) as typeof fetch;
  const client = new GitHubClient('o/r', 'fake', {fetch: fakeFetch});
  client.fetch_pr_meta = async () => ({head_sha: h.head, head_ref: 'test', base_ref: h.base});
  client.fetch_diff = async () => h.diff;
  client.fetch_repo_context = async () => '';
  client.fetch_pr_intent = async () => ({title: 'Fix calculation', body: ''});
  client.fetch_open_own_threads = async () => h.threads.filter(t => !t.resolved);
  client.fetch_resolved_own_threads = async () => h.threads.filter(t => t.resolved);
  client.fetch_thread_state = async () => {
    if (h.readError) throw new Error('GitHub unavailable');
    return [h.threads.filter(t => !t.resolved), h.threads.filter(t => t.resolved), h.complete];
  };
  client.fetch_own_summaries = async () => [[], true];
  client.latest_status_state = async () => h.nextExecution ?? [...h.statuses].reverse().find(s => s.context === 'Goby Review')?.state as string ?? null;
  const agent = async (): Promise<AgentReply> => {
    h.modelCalls++;
    if (h.moveDuringModel) h.head = OTHER;
    return {content: h.content, elapsed_s: 0.1, prompt_tokens: 100, completion_tokens: 10, turns: 1, tool_calls: 0,
      budget_exhausted: h.exhausted, final_truncated: h.truncated, tool_counts: {}};
  };
  return Object.assign(h, {client, run: (options: Partial<ReviewOptions> = {}) => review({pr: 1, repo: 'o/r', token: 'fake', api_key: 'fake',
    agent: true, fail_on_blocked: true, ...options}, {github: client, agent, warn: () => {}})});
}
function lastGate(h: ReturnType<typeof harness>): unknown { return [...h.statuses].reverse().find(s => s.context === 'Goby Gate')?.state; }

describe('TypeScript review and gate end-to-end, fake I/O only', () => {
  test('clean review passes using a persisted receipt', async () => {
    const h = harness(); const result = await h.run();
    expect(result.exitCode).toBe(0); expect(lastGate(h)).toBe('success'); expect(result.report.review_complete).toBe(true);
    expect(parseReceipt(String(h.rows[0].body), HEAD)?.complete).toBe(true);
  });
  for (const severity of ['low', 'medium', 'high']) test(`${severity} unresolved finding blocks eligibility, not execution`, async () => {
    const h = harness(); h.content = JSON.stringify([bug(severity)]);
    expect((await h.run()).exitCode).toBe(2); expect(lastGate(h)).toBe('failure');
    expect([...h.statuses].reverse().find(s => s.context === 'Goby Review')?.state).toBe('success');
  });
  for (const field of ['exhausted', 'truncated'] as const) test(`${field} blocks and is not reused`, async () => {
    const h = harness(); h[field] = true;
    expect((await h.run()).exitCode).toBe(2); expect(lastGate(h)).toBe('failure');
    h[field] = false; expect((await h.run()).exitCode).toBe(0); expect(h.modelCalls).toBe(2);
  });
  test('oversize skip cannot pass the gate or call the model', async () => {
    const h = harness(); expect((await h.run({max_diff_lines: 1})).exitCode).toBe(2);
    expect(h.modelCalls).toBe(0); expect(lastGate(h)).toBe('failure');
  });
  for (const content of ['invalid', '[{}]', JSON.stringify([bug(), {line: 1}]), '```json\n[]\n```\n```json\n[invalid]\n```']) {
    test(`malformed model reply fails closed: ${content.slice(0, 20)}`, async () => {
      const h = harness(); h.content = content;
      const result = await h.run(); expect(result.exitCode).toBe(1); expect(result.report.phase).toBe('error'); expect(lastGate(h)).toBe('error');
    });
  }
  test('summary-only findings block', async () => {
    const h = harness(); h.content = JSON.stringify([bug('high', 100)]);
    expect((await h.run()).exitCode).toBe(2); expect(lastGate(h)).toBe('failure');
  });
  test('capped findings block even after all published threads are resolved', async () => {
    const h = harness(); h.content = JSON.stringify([bug(), bug('medium', 100)]);
    expect((await h.run({max_findings: 1})).exitCode).toBe(2);
    h.threads.forEach(t => t.resolved = true);
    expect((await refreshGate(h.client, 1, {expected_head: HEAD})).state).toBe('failure');
  });
  test('422 fallback leaves missing expected threads and blocks', async () => {
    const h = harness(); h.fallback = true; h.content = JSON.stringify([bug()]);
    expect((await h.run()).exitCode).toBe(2); expect(h.threads.length).toBe(0); expect(lastGate(h)).toBe('failure');
  });
  test('incomplete thread reads cannot grant eligibility', async () => {
    const h = harness(); h.complete = false;
    expect((await h.run()).exitCode).toBe(2); expect(lastGate(h)).toBe('failure');
  });
  test('resolution refresh requires no model and duplicate events reuse the receipt', async () => {
    const h = harness(); h.content = JSON.stringify([bug()]);
    expect((await h.run()).exitCode).toBe(2);
    h.threads[0].resolved = true;
    expect((await refreshGate(h.client, 1, {expected_head: HEAD})).state).toBe('success');
    expect((await h.run()).exitCode).toBe(0); expect(h.modelCalls).toBe(1);
  });
  test('deleted threads are not resolutions', async () => {
    const h = harness(); h.content = JSON.stringify([bug()]); await h.run(); h.threads = [];
    expect((await refreshGate(h.client, 1)).state).toBe('failure');
  });
  test('stale event cannot publish on a newer head', async () => {
    const h = harness(); expect((await h.run({expected_head: OTHER})).exitCode).toBe(1);
    expect(h.rows).toEqual([]); expect(h.statuses).toEqual([]);
  });
  test('head movement during model execution cannot publish a review', async () => {
    const h = harness(); h.moveDuringModel = true;
    expect((await h.run()).exitCode).toBe(1); expect(h.rows).toEqual([]);
    expect(h.statuses.some(s => s.state === 'success')).toBe(false);
  });
  test('gate read error invalidates earlier success', async () => {
    const h = harness(); await h.run(); h.readError = true;
    expect((await refreshGate(h.client, 1)).state).toBe('error'); expect(lastGate(h)).toBe('error');
  });
  test('failed latest execution cannot reuse an old green receipt through gate alone', async () => {
    const h = harness(); await h.run(); h.nextExecution = 'error';
    expect((await refreshGate(h.client, 1)).state).toBe('failure');
  });
  test('dry-run does not post anything', async () => {
    const h = harness(); expect((await h.run({dry_run: true})).exitCode).toBe(0);
    expect(h.rows).toEqual([]); expect(h.statuses).toEqual([]);
  });
  test('retargeting invalidates the gate and forces a new model review', async () => {
    const h = harness(); expect((await h.run()).exitCode).toBe(0);
    h.base = 'release'; h.diff = DIFF.replace('return total - 1', 'return total - 2');
    expect((await refreshGate(h.client, 1, {expected_head: HEAD})).state).toBe('failure');
    expect((await h.run()).exitCode).toBe(0);
    expect(h.modelCalls).toBe(2);
  });
  test('a changed diff invalidates reuse even on the same base and head', async () => {
    const h = harness(); await h.run(); h.diff += '\nadditional change';
    expect((await refreshGate(h.client, 1)).state).toBe('failure');
    await h.run(); expect(h.modelCalls).toBe(2);
  });
  test('an older refresh revokes its success after a newer incomplete receipt wins', async () => {
    const h = harness(); await h.run();
    const original = h.client.fetch_pr_meta;
    let reads = 0, newerFinished = false;
    h.client.fetch_pr_meta = async pr => {
      if (++reads === 4) {
        h.rows.push({id: 2, commit_id: HEAD, state: 'COMMENTED', user: {login: 'github-actions[bot]'},
          body: '**Goby Review** — agentic review\n' + receiptMarker(receipt({complete: false}))});
        const newer = await refreshGate(h.client, 1, {expected_head: HEAD});
        expect(newer.state).toBe('failure'); newerFinished = true;
      }
      return original(pr);
    };
    const older = await refreshGate(h.client, 1, {expected_head: HEAD});
    expect(newerFinished).toBe(true);
    expect(older.state).toBe('failure');
    expect(lastGate(h)).toBe('failure');
  });
  test('force explicitly repeats a complete review', async () => {
    const h = harness(); await h.run(); await h.run({force: true}); expect(h.modelCalls).toBe(2);
  });
});

describe('receipt validation', () => {
  test('round trips typed receipt', () => expect(parseReceipt(receiptMarker(receipt()), HEAD)).toEqual(receipt()));
  for (const patch of [{schema: 1}, {schema: 3}, {complete: 1}, {agent: 'yes'}, {head_sha: OTHER}, {unthreaded: -1}, {finding_ids: ['a', 'a']}]) {
    test(`rejects malformed ${JSON.stringify(patch)}`, () => expect(parseReceipt(receiptMarker({...receipt(), ...patch} as ReviewReceipt), HEAD)).toBeNull());
  }
  test('rejects duplicated markers including injected text', () => expect(parseReceipt(`${receiptMarker(receipt())}\n${receiptMarker(receipt())}`, HEAD)).toBeNull());
  test('unknown metadata never allows permission', () => expect(evaluateGate(null, HEAD, [], [], true, true).state).toBe('failure'));
});
