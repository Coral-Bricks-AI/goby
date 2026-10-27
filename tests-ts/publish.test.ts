import { describe, expect, test } from 'bun:test';
import { GitHubClient } from '../src/platforms/github.ts';
import { _comment_position, comment_body, post_review, post_status, post_gate_status, reply_in_thread, resolve_thread } from '../src/platforms/publish.ts';
import { GATE_CONTEXT, STATUS_CONTEXT, REVIEW_VERSION } from '../src/identity.ts';
import { Finding, type FindingInput } from '../src/core/contract.ts';

function fake(handler: (payload: any, index: number) => unknown = () => ({ id: 1 })) {
  const calls: { url: string; method: string | undefined; payload: any }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const payload = JSON.parse(String(init.body));
    calls.push({ url: String(input), method: init.method, payload });
    const result = handler(payload, calls.length - 1);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return { client: new GitHubClient('owner/repo', 'secret', { fetch: fetcher }), calls };
}
const finding = (changes: Partial<FindingInput> = {}): Finding => Object.assign(
  new Finding({ path: 'a.ts', line: 7, severity: 'high', title: 'Bug', detail: 'Broken handle', ...changes }),
  { fid: 'ab12' },
);

describe('review publication', () => {
  test('single and range bodies preserve severity, fid, head and raise-time span', () => {
    expect(comment_body(finding(), '0123456789abcdef')).toBe('**[high] Bug**\n\nBroken handle\n\n<!-- goby id=ab12 severity=high kind=bug sha=0123456789 -->');
    expect(comment_body(finding({ end_line: 12, detail: '' }), '0123456789abcdef')).toBe('**[high] Bug**\n\n<!-- goby id=ab12 severity=high kind=bug sha=0123456789 start_line=7 end_line=12 -->');
    expect(_comment_position(finding())).toEqual({ path: 'a.ts', line: 7, side: 'RIGHT' });
    expect(_comment_position(finding({ end_line: 12 }))).toEqual({ path: 'a.ts', line: 12, side: 'RIGHT', start_line: 7, start_side: 'RIGHT' });
    expect(_comment_position(finding({ end_line: 7 }))).toEqual({ path: 'a.ts', line: 7, side: 'RIGHT' });
  });

  test('posts COMMENT review pinned to full head with versioned summary marker', async () => {
    const { client, calls } = fake();
    expect(await post_review(client, 7, '0123456789abcdef', 'summary \n\n', [finding(), finding({ end_line: 12 })])).toEqual({ id: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/owner/repo/pulls/7/reviews');
    expect(calls[0]!.method).toBe('POST');
    const payload = calls[0]!.payload;
    expect(payload.commit_id).toBe('0123456789abcdef');
    expect(payload.body).toBe(`summary\n\n<!-- goby head=0123456789 v=${REVIEW_VERSION} -->`);
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments).toEqual([finding(), finding({ end_line: 12 })].map(f => ({ ..._comment_position(f), body: comment_body(f, '0123456789abcdef') })));
  });

  test('422 fallback preserves every finding and head marker without mutating first payload', async () => {
    const { client, calls } = fake((_payload, i) => i === 0 ? new Response('position invalid', { status: 422 }) : { id: 2 });
    expect(await post_review(client, 1, '0123456789abcdef', 'summary', [finding({ detail: '🐟'.repeat(301) }), finding({ path: 'b.ts', title: 'Second' })])).toEqual({ id: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.payload.comments).toHaveLength(2);
    expect(calls[1]!.payload.comments).toEqual([]);
    expect(calls[1]!.payload.body).toContain(`head=0123456789 v=${REVIEW_VERSION}`);
    expect(calls[1]!.payload.body).toContain(`- \`a.ts:7\` **[high]** Bug — ${'🐟'.repeat(300)}\n`);
    expect(calls[1]!.payload.body).not.toContain('🐟'.repeat(301));
    expect(calls[1]!.payload.body).toContain('- `b.ts:7` **[high]** Second — Broken handle');
    expect(calls[1]!.payload.commit_id).toBe('0123456789abcdef');
    expect(calls[1]!.payload.event).toBe('COMMENT');
  });

  test('published Finding round-trips through the thread reader without losing identity or span', async () => {
    let published: any;
    const { client } = fake(payload => {
      if (!payload.query) { published = payload; return { id: 1 }; }
      const inline = published.comments[0];
      return { data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: 'T1', isResolved: false, isOutdated: false, comments: {
          nodes: [{ databaseId: 123, author: { login: 'github-actions' },
            body: inline.body, path: inline.path, line: inline.line,
            startLine: inline.start_line, originalLine: inline.line,
            originalStartLine: inline.start_line, createdAt: '2026-10-15' }],
          pageInfo: { hasNextPage: false },
        } }], pageInfo: { hasNextPage: false, endCursor: null },
      } } } } };
    });
    const f = new Finding({ path: 'src/a.ts', line: 7, end_line: 12, severity: 'medium', title: 'Range bug', detail: 'Evidence' });
    await post_review(client, 1, '0123456789abcdef', 'summary', [f]);
    const [opened, resolved, complete] = await client.fetch_thread_state(1);
    expect(complete).toBe(true);
    expect(resolved).toEqual([]);
    expect(opened[0]).toMatchObject({ fid: f.fid, sha: '0123456789', path: f.path,
      marker_start: 7, marker_end: 12, start_line: 7, line: 12,
      title: '[medium] Range bug', comment_id: 123 });
  });

  test('non-422 errors and empty-comment 422 never retry', async () => {
    for (const [status, findings] of [[403, [finding()]], [500, [finding()]], [422, []]] as const) {
      const { client, calls } = fake(() => new Response('failure', { status }));
      await expect(post_review(client, 1, 'head', 'summary', [...findings])).rejects.toMatchObject({ code: status });
      expect(calls).toHaveLength(1);
    }
  });

  test('fallback is tried only once and its failure propagates', async () => {
    const { client, calls } = fake(() => new Response('failure', { status: 422 }));
    await expect(post_review(client, 1, 'head', 'summary', [finding()])).rejects.toMatchObject({ code: 422 });
    expect(calls).toHaveLength(2);
  });
});

describe('statuses and thread writes', () => {
  test('execution and gate contexts are distinct with 140-character descriptions', async () => {
    const { client, calls } = fake();
    await post_status(client, 'head', 'error', '🐟'.repeat(141), 'https://run');
    await post_gate_status(client, 'head', 'failure', 'x'.repeat(141));
    expect(calls[0]!.url).toBe('https://api.github.com/repos/owner/repo/statuses/head');
    expect(calls[0]!.payload).toEqual({ state: 'error', context: STATUS_CONTEXT, description: '🐟'.repeat(140), target_url: 'https://run' });
    expect(calls[1]!.payload).toEqual({ state: 'failure', context: GATE_CONTEXT, description: 'x'.repeat(140) });
    await post_status(client, 'head', 'success', 'done');
    expect(calls[2]!.payload).not.toHaveProperty('target_url');
  });

  test('gate accepts only GitHub status states and does not write on invalid state', async () => {
    const { client, calls } = fake();
    for (const state of ['pending', 'success', 'failure', 'error']) await post_gate_status(client, 'head', state, state);
    await expect(post_gate_status(client, 'head', 'unknown', 'no')).rejects.toThrow('Invalid gate state');
    expect(calls).toHaveLength(4);
  });

  test('reply uses REST comment id while resolve uses GraphQL threadId', async () => {
    const { client, calls } = fake();
    await reply_in_thread(client, 8, 123, 'fixed');
    await resolve_thread(client, 'T_node');
    expect(calls[0]).toEqual({ url: 'https://api.github.com/repos/owner/repo/pulls/8/comments', method: 'POST', payload: { body: 'fixed', in_reply_to: 123 } });
    expect(calls[1]!.url).toBe('https://api.github.com/graphql');
    expect(calls[1]!.payload.variables).toEqual({ t: 'T_node' });
    expect(calls[1]!.payload.query).toContain('threadId: $t');
    expect(calls[1]!.payload.query).not.toContain('threadID');
  });

  test('resolution GraphQL errors are not swallowed', async () => {
    await expect(resolve_thread(fake(() => ({ errors: [{ message: 'denied' }] })).client, 'T_node')).rejects.toMatchObject({ code: 200 });
  });
});
