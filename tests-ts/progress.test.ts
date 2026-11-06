import { describe, expect, test } from 'bun:test';
import { body, is_ours, main, marker, start, stop, type Comment } from '../src/progress.ts';

type Call = { method: string; url: string; payload: any };

const HEAD = '0123456789abcdef';

function fake(comments: Comment[], fail: (c: Call) => number | null = () => null) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { method: init.method ?? 'GET', url: String(input), payload: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const status = fail(call);
    if (status) return new Response('nope', { status });
    if (call.method === 'GET') return Response.json(comments);
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 99 }, { status: call.method === 'POST' ? 201 : 200 });
  }) as typeof fetch;
  const short = () => calls.map(c => `${c.method} ${c.url.replace('https://api.github.com/repos/o/r', '')}`);
  return { calls, short, opts: { repo: 'o/r', pr: '7', token: 't', run: '42.1', head: HEAD, fetch: fetcher } };
}

const bot = (id: number, text: string): Comment => ({ id, body: text, user: { type: 'Bot' } });

describe('progress note', () => {
  test('reviewing carries the art and the head; done is one line naming the head', () => {
    const reviewing = body('42.1', 'reviewing', HEAD);
    expect(reviewing.startsWith(marker('42.1', 'reviewing'))).toBe(true);
    expect(reviewing).toContain('```text\n');
    expect(reviewing).toContain('><((((°>');
    expect(reviewing).toContain('`0123456789`');
    const done = body('42.1', 'done', HEAD);
    expect(done.startsWith(marker('42.1', 'done'))).toBe(true);
    expect(done).toContain('`0123456789`');
    expect(done).not.toContain('```');
  });

  test('ours means a bot comment leading with the marker, of the given run when named', () => {
    expect(is_ours(bot(1, body('42.1', 'reviewing', HEAD)))).toBe(true);
    expect(is_ours(bot(1, body('41.1', 'done', HEAD)))).toBe(true);
    expect(is_ours(bot(1, body('42.1', 'reviewing', HEAD)), '42.1')).toBe(true);
    expect(is_ours(bot(1, body('42.10', 'reviewing', HEAD)), '42.1')).toBe(false);
    expect(is_ours(bot(1, body('41.1', 'reviewing', HEAD)), '42.1')).toBe(false);
    expect(is_ours({ id: 1, body: body('42.1', 'done', HEAD), user: { type: 'User' } })).toBe(false);
    expect(is_ours(bot(1, `quoted:\n${body('42.1', 'done', HEAD)}`))).toBe(false);
    expect(is_ours(bot(1, '<!-- goby head=abc -->'))).toBe(false);
  });

  test('start posts the note when there is none', async () => {
    const { calls, short, opts } = fake([bot(2, 'unrelated')]);
    await start(opts);
    expect(short()).toEqual(['GET /issues/7/comments?per_page=100&page=1', 'POST /issues/7/comments']);
    expect(calls[1]!.payload.body).toBe(body('42.1', 'reviewing', HEAD));
  });

  test('start edits the oldest note in place and deletes any duplicate', async () => {
    const { calls, short, opts } = fake([bot(1, body('40.1', 'done', HEAD)), bot(2, 'unrelated'), bot(3, body('41.1', 'reviewing', HEAD))]);
    await start(opts);
    expect(short()).toEqual([
      'GET /issues/7/comments?per_page=100&page=1',
      'PATCH /issues/comments/1',
      'DELETE /issues/comments/3',
    ]);
    expect(calls[1]!.payload.body).toBe(body('42.1', 'reviewing', HEAD));
  });

  test("stop marks this run's note done, and leaves a note a newer run has claimed", async () => {
    const mine = fake([bot(1, body('42.1', 'reviewing', HEAD))]);
    await stop(mine.opts);
    expect(mine.short()).toEqual(['GET /issues/7/comments?per_page=100&page=1', 'PATCH /issues/comments/1']);
    expect(mine.calls[1]!.payload.body).toBe(body('42.1', 'done', HEAD));

    const claimed = fake([bot(1, body('43.1', 'reviewing', HEAD))]);
    await stop(claimed.opts);
    expect(claimed.short()).toEqual(['GET /issues/7/comments?per_page=100&page=1']);
  });

  test('main swallows API failures and missing inputs', async () => {
    const env = { GOBY_REPO: 'o/r', GOBY_PR: '7', GOBY_HEAD: HEAD, GITHUB_TOKEN: 't', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => { errors.push(m); };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    try {
      await expect(main(['start'], env)).resolves.toBeUndefined();
      await expect(main(['stop'], { ...env, GITHUB_TOKEN: '' })).resolves.toBeUndefined();
      await expect(main(['stop'], { ...env, GOBY_HEAD: '' })).resolves.toBeUndefined();
      await expect(main(['bogus'], env)).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      console.error = original;
    }
    expect(errors[0]).toContain('start failed, ignored: GET');
    expect(errors.slice(1).every(e => e.includes('skipped'))).toBe(true);
    expect(errors).toHaveLength(4);
  });
});
