import { describe, expect, test } from 'bun:test';
import { body, is_ours, main, marker, start, stop, type Comment } from '../src/progress.ts';

type Call = { method: string; url: string; payload: any };

function fake(comments: Comment[], fail: (c: Call) => number | null = () => null) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { method: init.method ?? 'GET', url: String(input), payload: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const status = fail(call);
    if (status) return new Response('nope', { status });
    if (call.method === 'GET') return Response.json(comments);
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 99 }, { status: 201 });
  }) as typeof fetch;
  return { calls, opts: { repo: 'o/r', pr: '7', token: 't', run: '42.1', fetch: fetcher } };
}

const bot = (id: number, text: string): Comment => ({ id, body: text, user: { type: 'Bot' } });

describe('progress note', () => {
  test('body leads with the run marker and carries the art in a code block', () => {
    expect(body('42.1').startsWith(marker('42.1'))).toBe(true);
    expect(body('42.1')).toContain('```text\n');
    expect(body('42.1')).toContain('><((((°>');
  });

  test('ours means a bot comment leading with the marker, of the given run when named', () => {
    expect(is_ours(bot(1, body('42.1')))).toBe(true);
    expect(is_ours(bot(1, body('42.1')), '42.1')).toBe(true);
    expect(is_ours(bot(1, body('41.1')), '42.1')).toBe(false);
    expect(is_ours({ id: 1, body: body('42.1'), user: { type: 'User' } })).toBe(false);
    expect(is_ours(bot(1, `quoted:\n${body('42.1')}`))).toBe(false);
    expect(is_ours(bot(1, '<!-- goby head=abc -->'))).toBe(false);
  });

  test('start clears every earlier note, then posts its own', async () => {
    const { calls, opts } = fake([bot(1, body('41.1')), bot(2, 'unrelated'), bot(3, body('40.2'))]);
    await start(opts);
    expect(calls.map(c => `${c.method} ${c.url.replace('https://api.github.com', '')}`)).toEqual([
      'GET /repos/o/r/issues/7/comments?per_page=100&page=1',
      'DELETE /repos/o/r/issues/comments/1',
      'DELETE /repos/o/r/issues/comments/3',
      'POST /repos/o/r/issues/7/comments',
    ]);
    expect(calls[3]!.payload.body).toBe(body('42.1'));
  });

  test("stop deletes only this run's note, so a cancelled run cannot remove its successor's", async () => {
    const { calls, opts } = fake([bot(1, body('41.1')), bot(2, body('42.1'))]);
    await stop(opts);
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['https://api.github.com/repos/o/r/issues/comments/2']);
  });

  test('main swallows API failures and missing inputs', async () => {
    const env = { GOBY_REPO: 'o/r', GOBY_PR: '7', GITHUB_TOKEN: 't', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => { errors.push(m); };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    try {
      await expect(main(['start'], env)).resolves.toBeUndefined();
      await expect(main(['stop'], { ...env, GITHUB_TOKEN: '' })).resolves.toBeUndefined();
      await expect(main(['bogus'], env)).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      console.error = original;
    }
    expect(errors[0]).toContain('start failed, ignored: GET');
    expect(errors[1]).toContain('skipped');
    expect(errors[2]).toContain('skipped');
  });
});
