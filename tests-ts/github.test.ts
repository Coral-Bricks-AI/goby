import { describe, expect, test } from 'bun:test';
import { GitHubClient, GitHubError, summaries_to_minimize } from '../src/platforms/github.ts';
import type { ThreadRecord as ContractThread } from '../src/core/contract.ts';

interface Call { url: string; init: RequestInit; payload: any }
function fake(handler: (call: Call, index: number) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init, payload: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const result = await handler(call, calls.length - 1);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return { client: new GitHubClient('owner/repo', 'secret', { fetch: fetcher }), calls, fetcher };
}
const connection = (nodes: any[], hasNextPage: unknown = false, endCursor: unknown = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const envelope = (kind: string, conn: any) => ({ data: { repository: { pullRequest: { [kind]: conn } } } });
const comment = (changes: any = {}) => ({
  databaseId: 1, author: { login: 'github-actions' }, path: 'a.ts', line: 14,
  startLine: 9, originalLine: 14, originalStartLine: 9, createdAt: '2026-10-15T10:00:00Z',
  body: '**[high] Leaks the handle**\n\nDetails\n<!-- goby id=ab12 severity=high kind=bug sha=deadbeef00 start_line=9 end_line=14 -->',
  ...changes,
});
const thread = (changes: any = {}) => ({
  id: 'T1', isResolved: false, isOutdated: false, comments: connection([comment()]), ...changes,
});
const review = (changes: any = {}) => ({
  id: 'R1', author: { login: 'github-actions' }, isMinimized: false,
  body: '**Goby Review** — one-turn review\n<!-- goby head=deadbeef00 v=0.1 -->', ...changes,
});

describe('GitHubClient transport and pinned reads', () => {
  test('owns repo/token/configuration and sends JSON, accept and 60s abort signal', async () => {
    const { client, calls } = fake(() => ({ id: 1 }));
    expect(client.repo).toBe('owner/repo');
    expect(client.token).toBe('secret');
    await client.get('/read', 'custom/diff');
    expect(await client.post('/write', { hello: 'world' })).toEqual({ id: 1 });
    expect(calls[0]!.url).toBe('https://api.github.com/read');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({ Authorization: 'Bearer secret', Accept: 'custom/diff' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.init.headers).toEqual({ Authorization: 'Bearer secret', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' });
    expect(calls[1]!.payload).toEqual({ hello: 'world' });
    expect(calls[1]!.init.method).toBe('POST');
  });

  test('HTTP errors retain code and bounded body; network errors use code zero', async () => {
    const { client } = fake(() => new Response('x'.repeat(400), { status: 403 }));
    let error: unknown;
    try { await client.get('/denied'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).code).toBe(403);
    expect((error as Error).message).toBe(`GitHub API 403 on /denied: ${'x'.repeat(300)}`);
    await expect(fake(() => { throw new Error('offline'); }).client.get('/read')).rejects.toMatchObject({ code: 0 });
    await expect(client.post('/denied', {})).rejects.toMatchObject({ code: 403 });
  });

  test('GraphQL sends variables and rejects HTTP-200 partial errors', async () => {
    const { client, calls } = fake(() => ({ data: { repository: null }, errors: [{ message: 'denied' }] }));
    await expect(client.graphql('query', { n: 1 })).rejects.toMatchObject({ code: 200 });
    expect(calls[0]!.payload).toEqual({ query: 'query', variables: { n: 1 } });
    const ok = fake(() => ({ data: {}, errors: [] }));
    expect(await ok.client.graphql('query')).toEqual({ data: {}, errors: [] });
    expect(ok.calls[0]!.payload.variables).toEqual({});
  });

  test('PR metadata, nullable intent and raw diff', async () => {
    const { client, calls } = fake((_c, i) => i === 2 ? new Response('diff --git a/x b/x\n') : { head: { sha: 'immutable', ref: 'branch' }, base: { ref: 'main', sha: 'base-commit' }, title: null, body: null });
    expect(await client.fetch_pr_meta(7)).toEqual({ head_sha: 'immutable', head_ref: 'branch', base_ref: 'main', base_sha: 'base-commit' });
    expect(await client.fetch_pr_intent(7)).toEqual({ title: '', body: '' });
    expect(await client.fetch_diff(7)).toBe('diff --git a/x b/x\n');
    expect(calls.every(c => c.url.endsWith('/repos/owner/repo/pulls/7'))).toBe(true);
    expect((calls[2]!.init.headers as any).Accept).toBe('application/vnd.github.v3.diff');
    await expect(fake(() => ({})).client.fetch_pr_meta(1)).rejects.toMatchObject({ code: 200 });
  });

  test('history is bounded and pinned, and fields default to empty strings', async () => {
    const { client, calls } = fake(() => [{ sha: 'abc', commit: { author: { date: 'date' }, message: 'message' } }, {}, null]);
    expect(await client.fetch_path_history('A & B.md', 'head/#', 3)).toEqual([{ sha: 'abc', date: 'date', message: 'message' }, { sha: '', date: '', message: '' }]);
    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: 'A & B.md', sha: 'head/#', per_page: '3' });
    await client.fetch_path_history('x', 'head');
    expect(new URL(calls[1]!.url).searchParams.get('per_page')).toBe('10');
    expect(await fake(() => ({})).client.fetch_path_history('x', 'head')).toEqual([]);
  });

  test('latest matching status wins, not any historical success', async () => {
    const { client, calls } = fake(() => [
      { context: 'Other', state: 'failure', updated_at: '2026-10-18' },
      { context: 'Goby Review', state: 'success', updated_at: '2026-10-15' },
      { context: 'Goby Review', state: 'error', updated_at: '2026-10-17' },
      { context: 'Goby Review', state: 'pending', updated_at: '2026-10-16' },
    ]);
    expect(await client.latest_status_state('head', 'Goby Review')).toBe('error');
    expect(await client.latest_status_state('head', 'Absent')).toBeNull();
    expect(calls[0]!.url).toEndWith('/commits/head/statuses?per_page=100');
  });
});

describe('thread state and completeness', () => {
  test('one traversal partitions open/resolved and preserves all anchors', async () => {
    const { client, calls } = fake(() => envelope('reviewThreads', connection([
      thread(), thread({ id: 'T2', isResolved: true, isOutdated: true, comments: connection([comment({ line: null })]) }),
      thread({ comments: connection([comment({ author: { login: 'human' } })]) }),
      thread({ comments: connection([comment({ body: 'ordinary bot comment' })]) }),
    ])));
    const [open, resolved, complete] = await client.fetch_thread_state(7);
    expect(complete).toBe(true);
    expect(open).toHaveLength(1);
    const compatible: ContractThread[] = open;
    expect(compatible).toBe(open);
    expect(resolved).toHaveLength(1);
    expect(open[0]).toEqual({ thread_id: 'T1', comment_id: 1, path: 'a.ts', line: 14, start_line: 9, original_line: 14, original_start_line: 9, marker_start: 9, marker_end: 14, sha: 'deadbeef00', outdated: false, created_at: '2026-10-15T10:00:00Z', title: '[high] Leaks the handle', fid: 'ab12', resolved: false });
    expect(resolved[0]!.line).toBe(14);
    expect(resolved[0]!.resolution).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.variables).toEqual({ owner: 'owner', name: 'repo', n: 7, cursor: null });
    expect(calls[0]!.payload.query).toContain('lastComment: comments(last: 1)');
  });

  test('single-list API keeps open outdated null line and only resolved records gain resolution', async () => {
    const { client } = fake(() => envelope('reviewThreads', connection([thread({ isOutdated: true, comments: connection([comment({ line: null })]) }), thread({ isResolved: true })])));
    const open = await client.fetch_open_own_threads(1);
    expect(open).toHaveLength(1);
    expect(open[0]!.line).toBeNull();
    expect(open[0]).not.toHaveProperty('resolution');
    expect(open[0]).not.toHaveProperty('resolved');
    expect(await client.fetch_resolved_own_threads(1)).toHaveLength(1);
  });

  test('true last comment beats a truncated prefix; content skips markers and caps at 200 characters', async () => {
    const { client } = fake(() => envelope('reviewThreads', connection([thread({ isResolved: true, comments: connection([comment(), comment({ databaseId: 2, body: 'stale' })], true), lastComment: { nodes: [comment({ databaseId: 99, body: '<!-- note -->\n**' + 'x'.repeat(250) + '**' })] } })])));
    expect((await client.fetch_resolved_own_threads(1))[0]!.resolution).toBe('x'.repeat(200));
  });

  test('resolution fallback requires explicit completeness, even for ten comments', async () => {
    for (const [page, expected] of [[undefined, ''], [{}, ''], [{ hasNextPage: true }, ''], [{ hasNextPage: 'false' }, ''], [{ hasNextPage: false }, 'last reply']] as const) {
      const comments = { nodes: [comment(), ...Array.from({ length: 9 }, () => comment({ databaseId: 2, body: '**last reply**' }))], ...(page === undefined ? {} : { pageInfo: page }) };
      const { client } = fake(() => envelope('reviewThreads', connection([thread({ isResolved: true, comments })])));
      expect((await client.fetch_resolved_own_threads(1))[0]!.resolution).toBe(expected);
    }
  });

  test('malformed pages and thread metadata never report complete', async () => {
    const invalid = [
      {}, { data: null }, { data: { repository: null } }, envelope('reviewThreads', { nodes: [] }),
      envelope('reviewThreads', connection([], 'false')), envelope('reviewThreads', connection([null])),
      envelope('reviewThreads', connection([thread({ isResolved: undefined })])),
      envelope('reviewThreads', connection([thread({ comments: { nodes: [] } })])),
      envelope('reviewThreads', connection([thread({ comments: connection([comment({ author: null })]) })])),
      envelope('reviewThreads', connection([thread({ comments: connection([comment({ body: null })]) })])),
      envelope('reviewThreads', connection([thread({ id: undefined })])),
    ];
    for (const data of invalid) expect((await fake(() => data).client.fetch_thread_state(1))[2]).toBe(false);
  });

  test('malformed later pages preserve earlier evidence but flag incomplete', async () => {
    const { client } = fake((_c, i) => i === 0 ? envelope('reviewThreads', connection([thread()], true, 'c1')) : {});
    const [open, , complete] = await client.fetch_thread_state(1);
    expect(open).toHaveLength(1);
    expect(complete).toBe(false);
  });

  test('pagination stops at four 50-thread pages, or succeeds at exactly 200', async () => {
    for (const finish of [false, true]) {
      const { client, calls } = fake((_c, i) => envelope('reviewThreads', connection(Array.from({ length: 50 }, () => thread()), !(finish && i === 3), `c${i}`)));
      const [open, , complete] = await client.fetch_thread_state(1);
      expect(open).toHaveLength(200);
      expect(calls).toHaveLength(4);
      expect(complete).toBe(finish);
      expect(calls.map(c => c.payload.variables.cursor)).toEqual([null, 'c0', 'c1', 'c2']);
    }
  });

  test('missing, stuck and cyclic cursors stop incomplete', async () => {
    for (const cursors of [[null], ['same', 'same'], ['a', 'b', 'a']]) {
      const { client, calls } = fake((_c, i) => envelope('reviewThreads', connection([], true, cursors[i])));
      expect((await client.fetch_thread_state(1))[2]).toBe(false);
      expect(calls).toHaveLength(cursors.length);
    }
  });

  test('custom login ownership applies to both threads and public gate configuration', async () => {
    const { fetcher } = fake(() => envelope('reviewThreads', connection([thread({ comments: connection([comment({ author: { login: 'my-bot' } })]) }), thread()])));
    const client = new GitHubClient('owner/repo', 't', { fetch: fetcher, botLogins: ['my-bot'] });
    expect(client.botLogins).toEqual(['my-bot']);
    expect(await client.fetch_open_own_threads(1)).toHaveLength(1);
    expect(await new GitHubClient('owner/repo', 't', { fetch: fetcher, botLogins: [] }).fetch_open_own_threads(1)).toEqual([]);
  });
});

describe('own reviews', () => {
  test('a review posted as the bot login but not ours does not count', async () => {
    // The login is shared with every workflow that posts as the app; counting those would let an
    // unrelated review suppress a whole pull request's review.
    const { client } = fake(() => [
      { user: { login: 'github-actions' }, commit_id: 'foreign', state: 'COMMENTED', body: 'Devin-style summary' },
      { user: { login: 'github-actions' }, commit_id: 'ours', state: 'COMMENTED', body: '**Goby Review** — sandboxed review\n\n<!-- goby head=ours v=1 -->' },
      { user: { login: 'a-human' }, commit_id: 'human', state: 'COMMENTED', body: '**Goby Review** copycat' },
    ]);
    expect((await client.own_reviews(1)).map(review => review.head)).toEqual(['ours']);
  });
});
