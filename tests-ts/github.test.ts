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
    const { client, calls } = fake((_c, i) => i === 2 ? new Response('diff --git a/x b/x\n') : { head: { sha: 'immutable', ref: 'branch' }, base: { ref: 'main' }, title: null, body: null });
    expect(await client.fetch_pr_meta(7)).toEqual({ head_sha: 'immutable', head_ref: 'branch', base_ref: 'main' });
    expect(await client.fetch_pr_intent(7)).toEqual({ title: '', body: '' });
    expect(await client.fetch_diff(7)).toBe('diff --git a/x b/x\n');
    expect(calls.every(c => c.url.endsWith('/repos/owner/repo/pulls/7'))).toBe(true);
    expect((calls[2]!.init.headers as any).Accept).toBe('application/vnd.github.v3.diff');
    await expect(fake(() => ({})).client.fetch_pr_meta(1)).rejects.toMatchObject({ code: 200 });
  });

  test('file content decodes UTF-8 and quotes both ref and path', async () => {
    const { client, calls } = fake(() => ({ content: Buffer.from('héllo\n').toString('base64') }));
    expect(await client.fetch_file('head/#1', 'docs/A & B.md')).toBe('héllo\n');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/repos/owner/repo/contents/docs/A%20%26%20B.md');
    expect(url.searchParams.get('ref')).toBe('head/#1');
  });

  test('missing files/listings return null, other HTTP errors propagate', async () => {
    for (const status of [404, 403, 500]) {
      const { client } = fake(() => new Response('no', { status }));
      for (const read of [() => client.fetch_file('head', 'x'), () => client.fetch_dir_listing('head', 'x')]) {
        if (status === 404) expect(await read()).toBeNull();
        else await expect(read()).rejects.toMatchObject({ code: status });
      }
    }
    expect(await fake(() => []).client.fetch_file('head', 'dir')).toBeNull();
    expect(await fake(() => ({ type: 'file' })).client.fetch_dir_listing('head', 'x')).toBeNull();
  });

  test('large files emit a note instead of silently providing empty context', async () => {
    const original = console.error;
    const notes: string[] = [];
    console.error = (...args: any[]) => { notes.push(args.join(' ')); };
    try {
      expect(await fake(() => ({ size: 1_500_000 })).client.fetch_file('head', 'large')).toBeNull();
    } finally { console.error = original; }
    expect(notes).toEqual(['note: large at head is 1500000 bytes (>1MB); skipping as context']);
  });

  test('directory listings preserve the 1000-entry cap for caller disclosure', async () => {
    const { client, calls } = fake(() => [...Array.from({ length: 1000 }, (_, i) => ({ name: String(i), type: 'file' })), null, 'bad']);
    const entries = await client.fetch_dir_listing('head', '');
    expect(entries).toHaveLength(1000);
    expect(entries![0]).toEqual({ name: '0', type: 'file' });
    expect(new URL(calls[0]!.url).pathname).toBe('/repos/owner/repo/contents/');
  });

  test('tree paths are sorted blobs with truncation flag exposed', async () => {
    const { client, calls } = fake(() => ({ tree: [{ path: 'z', type: 'blob' }, { path: 'dir', type: 'tree' }, null, { path: 'a', type: 'blob' }], truncated: true }));
    expect(await client.fetch_tree_paths('head/ref')).toEqual([['a', 'z'], true]);
    expect(calls[0]!.url).toEndWith('/git/trees/head%2Fref?recursive=1');
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

  test('repo context is head-pinned, ordered and truncated per file', async () => {
    const { client, calls } = fake(() => ({ content: Buffer.from('🐟'.repeat(20001)).toString('base64') }));
    expect(await client.fetch_repo_context('immutable')).toBe(`### CLAUDE.md\n\n${'🐟'.repeat(20000)}\n\n### AGENTS.md\n\n${'🐟'.repeat(20000)}`);
    expect(calls.map(c => new URL(c.url).searchParams.get('ref'))).toEqual(['immutable', 'immutable']);
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

describe('summaries, head dedupe and minimization', () => {
  test('summaries paginate, filter author and retain minimized placeholders and mode', async () => {
    const { client, calls } = fake((_c, i) => envelope('reviews', i === 0 ? connection([
      review(), review({ id: 'human', author: { login: 'human' } }),
      review({ id: 'agent', body: '**Goby Review** — agentic review\n<!-- goby head=beef -->' }),
    ], true, 'c1') : connection([review({ id: 'R2', body: 'placeholder', isMinimized: true })])));
    expect(await client.fetch_own_summaries(1)).toEqual([[
      { node_id: 'R1', sha: 'deadbeef00', minimized: false, agent: false },
      { node_id: 'agent', sha: 'beef', minimized: false, agent: true },
      { node_id: 'R2', sha: '', minimized: true, agent: false },
    ], true]);
    expect(calls.map(c => c.payload.variables.cursor)).toEqual([null, 'c1']);
  });

  test('summary pagination caps at five 100-review pages and reports incomplete', async () => {
    const { client, calls } = fake((_c, i) => envelope('reviews', connection(Array.from({ length: 100 }, () => review()), true, `c${i}`)));
    const [records, complete] = await client.fetch_own_summaries(1);
    expect(records).toHaveLength(500);
    expect(calls).toHaveLength(5);
    expect(complete).toBe(false);
  });

  test('unknown summary pages and invalid cursors fail closed', async () => {
    for (const data of [{}, envelope('reviews', {}), envelope('reviews', connection([], 'false')), envelope('reviews', connection([null])), envelope('reviews', connection([review({ isMinimized: undefined })])), envelope('reviews', connection([], true, null))]) {
      expect((await fake(() => data).client.fetch_own_summaries(1))[1]).toBe(false);
    }
    const stuck = fake(() => envelope('reviews', connection([], true, 'same')));
    expect((await stuck.client.fetch_own_summaries(1))[1]).toBe(false);
    expect(stuck.calls).toHaveLength(2);
  });

  test('only fully resolved raised rounds minimize; clean, live, agentic and minimized rounds stay', () => {
    const summaries = ['resolved', 'open', 'clean', 'agent', 'minimized', ''].map(sha => ({ node_id: sha, sha, minimized: sha === 'minimized', agent: sha === 'agent' }));
    const records = summaries.map(s => ({ sha: s.sha }));
    expect(summaries_to_minimize(summaries, [{ sha: 'open' }], records.filter(t => t.sha !== 'clean')).map(s => s.sha)).toEqual(['resolved']);
  });

  test('minimizeComment uses RESOLVED and propagates GraphQL errors', async () => {
    const { client, calls } = fake(() => ({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }));
    expect(await client.minimize_comment('R1')).toBe(true);
    expect(calls[0]!.payload.variables).toEqual({ id: 'R1' });
    expect(calls[0]!.payload.query).toContain('classifier: RESOLVED');
    expect(await fake(() => ({ data: {} })).client.minimize_comment('R1')).toBe(false);
    await expect(fake(() => ({ errors: [{ message: 'forbidden' }] })).client.minimize_comment('R1')).rejects.toMatchObject({ code: 200 });
  });

  test('head guard accepts legacy/versioned markers and minimized commit fallback only for bot', async () => {
    for (const body of ['<!-- goby head=0123456789 -->', '<!-- goby head=0123456789 v=0.2 -->', 'placeholder']) {
      const { client } = fake(() => [{ user: { login: 'github-actions[bot]' }, body, commit_id: '0123456789abcdef' }]);
      expect(await client.head_already_reviewed(1, '0123456789abcdef')).toBe(true);
      expect(await client.head_already_reviewed(1, 'different')).toBe(false);
      expect(await client.head_already_reviewed(1, '0123456789abcdef', true)).toBe(false);
    }
    expect(await fake(() => [{ user: { login: 'human' }, commit_id: 'head' }]).client.head_already_reviewed(1, 'head')).toBe(false);
  });

  test('agent mode is anchored to header, not findings prose; head prefix requires delimiter', async () => {
    const { client } = fake(() => [{ user: { login: 'github-actions' }, body: '**Goby Review** — one-turn review\nmentions agentic review\n<!-- goby head=0123456789 v=1 -->' }]);
    expect(await client.head_already_reviewed(1, '0123456789abcdef', true)).toBe(false);
    const agent = fake(() => [{ user: { login: 'github-actions' }, body: '**Goby Review** — agentic review (v1)\n<!-- goby head=0123456789 -->' }]);
    expect(await agent.client.head_already_reviewed(1, '0123456789abcdef', true)).toBe(true);
    expect(await fake(() => [{ user: { login: 'github-actions' }, body: '<!-- goby head=01234567890 -->' }]).client.head_already_reviewed(1, '0123456789abcdef')).toBe(false);
  });

  test('head guard follows reviews but is bounded at twenty pages', async () => {
    const { client, calls } = fake(() => Array.from({ length: 100 }, () => ({ user: { login: 'human' } })));
    expect(await client.head_already_reviewed(1, 'head')).toBe(false);
    expect(calls).toHaveLength(20);
    expect(calls.at(-1)!.url).toEndWith('reviews?per_page=100&page=20');
  });
});

describe('batched pinned reads', () => {
  const blob = (text: unknown, extra: Record<string, unknown> = {}) => ({ text, byteSize: 10, isBinary: false, isTruncated: false, ...extra });

  test('one request per batch, with the pinned commit in every expression', async () => {
    const paths = Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`);
    const { client, calls } = fake((call) => {
      const query = JSON.parse(String(call.init.body)).query as string;
      const aliases = [...query.matchAll(/f(\d+): object\(expression: "([^"]+)"\)/g)];
      const repository = Object.fromEntries(aliases.map(([, index, expression]) => [`f${index}`, blob(expression)]));
      return { data: { repository } };
    });
    const texts = await client.fetch_texts('deadbeef', paths);
    expect(calls).toHaveLength(2); // 100 + 50
    expect(texts.size).toBe(150);
    for (const [index, path] of paths.entries()) expect(texts.get(path)).toBe(`deadbeef:${path}`);
    expect(calls[0]!.url).toBe('https://api.github.com/graphql');
    expect(JSON.stringify(JSON.parse(String(calls[0]!.init.body)).variables)).toBe(JSON.stringify({ owner: 'owner', name: 'repo' }));
  });

  test('binary, truncated, oversized, null and missing blobs are all null — never a half file', async () => {
    const { client } = fake(() => ({ data: { repository: {
      f0: blob('ok'),
      f1: blob('binary?', { isBinary: true }),
      f2: blob('cut', { isTruncated: true }),
      f3: blob('huge', { byteSize: 2 * 1024 * 1024 }),
      f4: null,
      f5: { text: 42 },
    } } }));
    const paths = ['a', 'b', 'c', 'd', 'e', 'f'];
    const texts = await client.fetch_texts('ref', paths);
    expect([...texts.entries()]).toEqual([['a', 'ok'], ['b', null], ['c', null], ['d', null], ['e', null], ['f', null]]);
  });

  test('a GraphQL error stops the batch instead of being reported as empty files', async () => {
    const { client } = fake(() => ({ errors: [{ message: 'Something went wrong' }] }));
    await expect(client.fetch_texts('ref', ['a.ts'])).rejects.toBeInstanceOf(GitHubError);
    const noRepo = fake(() => ({ data: {} }));
    await expect(noRepo.client.fetch_texts('ref', ['a.ts'])).rejects.toThrow(/Missing repository/);
  });

  test('an empty path list makes no request', async () => {
    const { client, calls } = fake(() => ({ data: { repository: {} } }));
    expect((await client.fetch_texts('ref', [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
