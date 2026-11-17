import { describe, expect, test } from 'bun:test';
import { collect, collectIssues, collectReviews, collectRuns } from '../src/wake/collect.ts';
import { classify, HINTS, issueMarker, issueRecord, reviewRecord, runProduct, runRecord } from '../src/wake/records.ts';
import { options } from '../src/wake/main.ts';
import { recordMarker, type RunRecord as MarkerRecord } from '../src/core/record.ts';
import { GitHubClient, type ThreadRecord } from '../src/platforms/github.ts';

const thread = (changes: Partial<ThreadRecord> = {}): ThreadRecord => ({
  thread_id: 'T1', comment_id: 1, path: 'src/a.ts', line: 12, start_line: null,
  original_line: 12, original_start_line: null, marker_start: null, marker_end: null,
  sha: 'deadbeef00', outdated: false, created_at: '2026-10-15T10:00:00Z',
  title: '[high] Leaks', fid: 'ab12', severity: 'high', ...changes,
});

const runMarker = (changes: Partial<MarkerRecord> = {}): MarkerRecord => ({
  schema: 1, product: 'review', v: '0.4.0', complete: true, model: 'coral/x', measured: true,
  agent_s: 118.4, turns: 9, tool_calls: 31, cost: { cents: 12.34, usd: 0.1234, note: null },
  ...changes,
});

const body = (record: MarkerRecord | null = runMarker(), version = '0.4.0'): string =>
  `**Goby Review** — sandboxed review.\n\n<!-- goby head=deadbeef00 v=${version} -->` +
  (record ? `\n${recordMarker(record)}` : '');

describe('classifying what became of a finding', () => {
  test('resolved is acted on', () => {
    expect(classify(thread({ resolved: true }))).toEqual({ outcome: 'acted_on' });
  });

  test('a resolved thread that names a commit carries that commit', () => {
    expect(classify(thread({ resolved: true, resolution: 'fixed in 1a2b3c4' })))
      .toEqual({ outcome: 'acted_on', fix: '1a2b3c4' });
  });

  test('a reply that argues back is disputed, not a false positive', () => {
    // The author of the change is not a neutral judge. Counting their "out of scope" as proof
    // the finding was wrong is how a precision number becomes flattering.
    expect(classify(thread({ resolved: false, resolution: 'out of scope for this PR' })))
      .toEqual({ outcome: 'disputed' });
  });

  test('no reply and still open is ignored', () => {
    expect(classify(thread({ resolved: false }))).toEqual({ outcome: 'ignored' });
    expect(classify(thread({ resolved: false, resolution: '' }))).toEqual({ outcome: 'ignored' });
  });

  test('a line rewritten underneath it is superseded', () => {
    expect(classify(thread({ resolved: false, outdated: true, resolution: 'we rewrote this file' })))
      .toEqual({ outcome: 'superseded' });
  });

  test('resolution outranks a stale line', () => {
    expect(classify(thread({ resolved: true, outdated: true })).outcome).toBe('acted_on');
  });
});

describe('a review record', () => {
  test('carries the run marker, the version, and the findings against its own commit', () => {
    const record = reviewRecord(7, {
      head: 'deadbeef00112233', body: body(), submitted_at: '2026-10-15T10:05:00Z',
    }, [
      thread({ resolved: true, resolution: 'done' }),
      thread({ thread_id: 'T2', path: 'src/b.ts', resolution: 'out of scope' }),
      thread({ thread_id: 'T3', sha: 'ffffffffff' }),
    ], true);
    expect(record).toMatchObject({
      kind: 'review', pr: 7, head: 'deadbeef00', at: '2026-10-15T10:05:00Z', v: '0.4.0',
      threads_complete: true,
    });
    // The third thread belongs to a later commit, so it is not this review's finding.
    expect(record.findings.map(f => f.outcome)).toEqual(['acted_on', 'disputed']);
    expect(record.findings[0]).toMatchObject({ path: 'src/a.ts', line: 12, severity: 'high' });
    expect(record.run).toMatchObject({ schema: 1, cost: { cents: 12.34 } });
  });

  test('an open thread the author argued back on reaches the real GitHub client and is disputed, end to end', async () => {
    // The unit tests above hand `reviewRecord` a `ThreadRecord` built by hand, which cannot catch
    // a gap between what `GitHubClient` actually returns and what `classify` expects of it — that
    // gap is exactly what let `disputed` go unreachable (goby-cleaners #171). This one goes
    // through the real client's GraphQL parsing instead of constructing the record directly.
    const fetcher = (async (_input: string | URL | Request, _init: RequestInit = {}) => Response.json({
      data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'T1', isResolved: false, isOutdated: false,
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                databaseId: 1, author: { login: 'github-actions' }, path: 'src/a.ts', line: 12,
                startLine: null, originalLine: 12, originalStartLine: null,
                createdAt: '2026-10-15T10:00:00Z',
                body: '**[high] Leaks the handle**\n\nDetails\n' +
                  '<!-- goby id=ab12 severity=high kind=bug sha=deadbeef00 -->',
              },
              {
                databaseId: 2, author: { login: 'human' }, path: 'src/a.ts', line: 12,
                startLine: null, originalLine: 12, originalStartLine: null,
                createdAt: '2026-10-15T11:00:00Z', body: 'out of scope for this PR',
              },
            ],
          },
        }],
      } } } },
    })) as typeof fetch;
    const client = new GitHubClient('owner/repo', 'secret', { fetch: fetcher });
    const [open, resolved, complete] = await client.fetch_thread_state(7);
    expect(complete).toBe(true);
    const record = reviewRecord(7, { head: 'deadbeef00112233', body: body(), submitted_at: '2026-10-15T10:05:00Z' }, [...open, ...resolved], complete);
    expect(record.findings).toEqual([{ path: 'src/a.ts', line: 12, severity: 'high', outdated: false, outcome: 'disputed' }]);
  });

  test('a review posted before the run marker existed still names its version', () => {
    const record = reviewRecord(7, {
      head: 'deadbeef0011', body: body(null, '0.3.0'), submitted_at: '2026-10-15T10:05:00Z',
    }, [], true);
    expect(record.v).toBe('0.3.0');
    expect(record.run).toBeNull();
  });

  test('an unreadable thread list is reported rather than passed off as no findings', () => {
    const record = reviewRecord(7, {
      head: 'deadbeef0011', body: body(), submitted_at: '2026-10-15T10:05:00Z',
    }, [], false);
    expect(record.threads_complete).toBe(false);
    expect(record.findings).toEqual([]);
  });

  test('stays under the two kilobytes the design promised', () => {
    const many = Array.from({ length: 12 }, (_, i) => thread({
      thread_id: `T${i}`, path: `src/some/longer/path/file${i}.ts`,
      resolution: 'fixed in 0a1b2c3, thanks — the handle is released in the finally block now',
    }));
    const record = reviewRecord(7, {
      head: 'deadbeef0011', body: body(), submitted_at: '2026-10-15T10:05:00Z',
    }, many, true);
    expect(JSON.stringify(record).length).toBeLessThan(2048);
  });
});

describe('an issue record', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');

  test('reads the cleaners marker', () => {
    expect(issueMarker('<!-- goby-cleaners fp=0123456789ab component=src/cli severity=high v=0.4.0 -->\n\nbody'))
      .toEqual({
        product: 'goby-cleaners', fingerprint: '0123456789ab',
        fields: { fp: '0123456789ab', component: 'src/cli', severity: 'high', v: '0.4.0' },
      });
  });

  test('reads the tide marker, and a path with a space in it', () => {
    const found = issueMarker('<!-- goby-tide fp=0123456789ab check=max_file_lines path=services/api v2/x.py v=0.4.0 -->');
    expect(found?.product).toBe('goby-tide');
    expect(found?.fields.path).toBe('services/api v2/x.py');
    expect(found?.fields.v).toBe('0.4.0');
  });

  test('a marker filed before versions existed has no version, not a guessed one', () => {
    const found = issueMarker('<!-- goby-tide fp=0123456789ab check=max_file_lines path=a.py -->');
    expect(found?.fields.v).toBeUndefined();
  });

  test('carries the outcome fields a backlog view needs', () => {
    const record = issueRecord({
      number: 12, title: '[goby-cleaners] src/cli: handle leak', state: 'closed',
      state_reason: 'not_planned', created_at: '2026-09-01T00:00:00Z',
      closed_at: '2026-10-01T00:00:00Z',
      body: '<!-- goby-cleaners fp=0123456789ab component=src/cli severity=high v=0.4.0 -->',
    }, now);
    expect(record).toMatchObject({
      kind: 'issue', number: 12, product: 'goby-cleaners', v: '0.4.0', state: 'closed',
      state_reason: 'not_planned', path: 'src/cli', severity: 'high', age_days: 44,
    });
  });

  test('an issue with no marker is not a goby filing', () => {
    expect(issueRecord({ number: 1, body: 'just a bug report' }, now)).toBeNull();
  });
});

describe('a workflow run record', () => {
  test('names the product and measures how long the run took', () => {
    const record = runRecord({
      name: 'Goby review', event: 'pull_request', conclusion: 'success',
      created_at: '2026-10-15T10:00:00Z', run_started_at: '2026-10-15T10:00:05Z',
      updated_at: '2026-10-15T10:02:35Z',
    });
    expect(record).toMatchObject({ product: 'review', conclusion: 'success', duration_s: 150 });
  });

  test('a product workflow is one named after the product', () => {
    expect(runProduct('Goby review')).toBe('review');
    expect(runProduct('Goby cleaners')).toBe('cleaners');
    expect(runProduct('goby-tide')).toBe('tide');
    expect(runProduct('goby_wake')).toBe('wake');
  });

  test('tooling that merely mentions a product is not a product run', () => {
    // This repository publishes an image from "review image" and tests one from "test review
    // image". Counting those made a publish look like a scan, its build time look like review
    // time, and a red lint job look like a failed review.
    for (const name of ['review image', 'test review image', 'test cleaners', 'tide image',
      'test tide', 'test wake image', 'wake image', 'CI', '']) {
      expect(runProduct(name)).toBeNull();
    }
  });

  test('an unfinished run has no duration rather than zero', () => {
    const record = runRecord({ name: 'Goby review', created_at: '2026-10-15T10:00:00Z' });
    expect(record.duration_s).toBeNull();
    expect(record.conclusion).toBeNull();
  });

  // goby-cleaners #169/#173/#179/#204: `updated_at` keeps moving on a run that has started but
  // not concluded, so "elapsed so far" used to be reported as a real, finished duration — a
  // review ten minutes into a run read as a ten-minute review.
  test('a run still in progress has no duration, even though it has started and updated', () => {
    const record = runRecord({
      name: 'Goby review', created_at: '2026-10-15T10:00:00Z',
      run_started_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:10:00Z',
      status: 'in_progress', conclusion: null,
    });
    expect(record.duration_s).toBeNull();
    expect(record.conclusion).toBeNull();
  });

  test('a queued run with no start time yet still has no duration', () => {
    const record = runRecord({
      name: 'Goby review', created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z',
      status: 'queued', conclusion: null,
    });
    expect(record.duration_s).toBeNull();
  });
});

/** A client with just the four things the collector asks of it. */
function stub(overrides: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const answer = (overrides.get ?? (async () => JSON.stringify([]))) as (path: string) => Promise<string>;
  const base = {
    repo: 'owner/repo',
    own_reviews: async () => [],
    fetch_thread_state: async () => [[], [], true] as [ThreadRecord[], ThreadRecord[], boolean],
    ...overrides,
    // Recording last, so a test that overrides `get` is still observed.
    get: async (path: string) => { asked.push(path); return answer(path); },
  };
  return { client: base as any, asked };
}

const window = { since: '2026-09-16T00:00:00Z', days: 30 };

describe('collecting', () => {
  test('everything unreadable is named in the notes, not left as an empty list', async () => {
    const { client } = stub({ get: async () => { throw new Error('boom'); } });
    const result = await collect(client, window, 100);
    expect(result.notes).toEqual([
      'reviews unavailable: boom', 'issues unavailable: boom', 'runs unavailable: boom',
    ]);
    expect(result.reviews).toEqual([]);
  });

  test('a pull request updated inside the window is read even when the review is older', async () => {
    const { client } = stub({
      get: async () => JSON.stringify([
        { number: 1, updated_at: '2026-10-01T00:00:00Z' },
        { number: 2, updated_at: '2026-01-01T00:00:00Z' },
      ]),
      own_reviews: async (pr: number) => pr === 1 ? [
        { head: 'deadbeef00aa', body: body(), id: 5, submitted_at: '2026-09-01T00:00:00Z' },
        { head: 'deadbeef00bb', body: body(), id: 6, submitted_at: '2026-10-20T00:00:00Z' },
      ] : [],
    });
    const notes: string[] = [];
    const reviews = await collectReviews(client, window, 100, notes);
    // Only the review inside the window, though both belong to a pull request updated inside it.
    expect(reviews.map(r => r.at)).toEqual(['2026-10-20T00:00:00Z']);
    expect(notes).toEqual([]);
  });

  test('an unreadable thread list becomes a note, and does not stop the review', async () => {
    const { client } = stub({
      get: async () => JSON.stringify([{ number: 1, updated_at: '2026-10-01T00:00:00Z' }]),
      own_reviews: async () => [
        { head: 'deadbeef00aa', body: body(), id: 5, submitted_at: '2026-10-01T00:00:00Z' }],
      fetch_thread_state: async () => [[], [], false] as [ThreadRecord[], ThreadRecord[], boolean],
    });
    const notes: string[] = [];
    const reviews = await collectReviews(client, window, 100, notes);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.threads_complete).toBe(false);
    expect(notes).toEqual(['pull request #1: review threads could not be read in full']);
  });

  test('the cap is stated when it bites', async () => {
    const { client } = stub({
      get: async () => JSON.stringify([{ number: 1, updated_at: '2026-10-01T00:00:00Z' }]),
      own_reviews: async () => [1, 2, 3].map(i => ({
        head: `deadbeef000${i}`, body: body(), id: i, submitted_at: '2026-10-01T00:00:00Z' })),
    });
    const notes: string[] = [];
    const reviews = await collectReviews(client, window, 2, notes);
    expect(reviews).toHaveLength(2);
    expect(notes).toContain('reviews truncated at 2');
  });

  test('issues are read through the general label and filtered by product marker', async () => {
    const { client, asked } = stub({
      get: async () => JSON.stringify([
        { number: 1, state: 'open', created_at: '2026-10-01T00:00:00Z',
          labels: [{ name: 'goby' }, { name: 'goby-cleaners' }],
          body: '<!-- goby-cleaners fp=0123456789ab component=a severity=high v=0.4.0 -->' },
        { number: 2, state: 'open', created_at: '2026-10-01T00:00:00Z', labels: [{ name: 'goby' }],
          body: 'not a goby filing' },
        // A pull request is an issue to this endpoint and must not become a record.
        { number: 3, state: 'open', created_at: '2026-10-01T00:00:00Z', pull_request: {},
          labels: [{ name: 'goby' }], body: 'x' },
      ]),
    });
    const issues = await collectIssues(client, window, 100, []);
    expect(issues.map(i => i.number)).toEqual([1]);
    expect(asked[0]).toContain('labels=goby');
  });

  test('an old open issue stays in the backlog; one closed long ago does not', async () => {
    const { client } = stub({
      get: async () => JSON.stringify([
        { number: 1, state: 'open', created_at: '2024-01-01T00:00:00Z',
          labels: [{ name: 'goby-cleaners' }],
          body: '<!-- goby-cleaners fp=000000000001 component=a severity=low -->' },
        { number: 2, state: 'closed', created_at: '2024-01-01T00:00:00Z',
          closed_at: '2024-02-01T00:00:00Z', labels: [{ name: 'goby-cleaners' }],
          body: '<!-- goby-cleaners fp=000000000002 component=a severity=low -->' },
      ]),
    });
    const issues = await collectIssues(client, window, 100, []);
    expect(issues.map(i => i.number)).toEqual([1]);
  });

  test('runs are asked for by workflow, so another project\'s CI cannot spend the page budget',
    async () => {
      // `/actions/runs` returns every workflow newest-first: on www that covered barely a day of a
      // seven-day window, silently, because the pages ran out before the window did.
      const { client, asked } = stub({
        get: async (path: string) => {
          if (path.includes('/actions/workflows?')) {
            return JSON.stringify({ workflows: [
              { id: 11, name: 'Goby review' }, { id: 12, name: 'CI' },
              { id: 13, name: 'Goby cleaners' }] });
          }
          if (path.includes('/workflows/11/runs')) {
            return JSON.stringify({ workflow_runs: [
              { name: 'Goby review', created_at: '2026-10-01T00:00:00Z', conclusion: 'success',
                run_started_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:03:00Z' },
            ] });
          }
          if (path.includes('/workflows/13/runs')) {
            return JSON.stringify({ workflow_runs: [
              { name: 'Goby cleaners', created_at: '2026-10-02T00:00:00Z', conclusion: 'failure',
                run_started_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:40Z' },
            ] });
          }
          return JSON.stringify({});
        },
      });
      const runs = await collectRuns(client, window, 100, []);
      expect(runs.map(r => r.product).sort()).toEqual(['cleaners', 'review']);
      // The unrelated workflow is never asked for its runs at all.
      expect(asked.some(path => path.includes('/workflows/12/'))).toBe(false);
      expect(asked.some(path => path.includes('created='))).toBe(true);
    });

  // goby-cleaners #167/#172: a walk that never reaches the window boundary and never gets a
  // short page used to fall out of its `page <= 10` loop in silence. These pin the fixed shape:
  // the page budget is stated in `notes` when it, rather than the window, is why the walk stopped.
  test('a reviews walk that never reaches the window is reported, not read as an empty one', async () => {
    const { client, asked } = stub({
      get: async (path: string) => {
        const page = Number(new URL(path, 'https://x').searchParams.get('page'));
        // Every page is full and inside the window, so the walk never sees a short page or a date
        // before `since` — the only way it stops is running out of its page budget.
        return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
          number: page * 100 + i, updated_at: '2026-10-01T00:00:00Z',
        })));
      },
    });
    const notes: string[] = [];
    const reviews = await collectReviews(client, window, 10_000, notes);
    expect(reviews).toEqual([]);
    expect(notes).toEqual(['pull request walk truncated at 50 pages of 100']);
    expect(asked).toHaveLength(50);
  });

  test('an issues walk that never reaches a short page is reported the same way', async () => {
    const { client, asked } = stub({
      get: async (path: string) => {
        const page = Number(new URL(path, 'https://x').searchParams.get('page'));
        // Every one of them a real cleaners filing, so the only note the walk can produce is the
        // page-cap one — not the per-issue "no readable marker" note this would drown in otherwise.
        return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
          number: page * 100 + i, state: 'open', created_at: '2026-10-01T00:00:00Z',
          labels: [{ name: 'goby-cleaners' }],
          body: `<!-- goby-cleaners fp=${String(page * 100 + i).padStart(12, '0')} component=a severity=low -->`,
        })));
      },
    });
    const notes: string[] = [];
    const issues = await collectIssues(client, window, 10_000, notes);
    expect(issues).toHaveLength(5000);
    expect(notes).toEqual(['issue walk truncated at 50 pages of 100']);
    expect(asked).toHaveLength(50);
  });

  test('a runs walk that never reaches a short page is reported per workflow', async () => {
    const { client } = stub({
      get: async (path: string) => {
        if (path.includes('/actions/workflows?')) {
          return JSON.stringify({ workflows: [{ id: 11, name: 'Goby review' }] });
        }
        const page = Number(new URL(path, 'https://x').searchParams.get('page'));
        return JSON.stringify({ workflow_runs: Array.from({ length: 100 }, (_, i) => ({
          name: 'Goby review', created_at: '2026-10-01T00:00:00Z', conclusion: 'success',
          run_started_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:03:00Z',
        })) });
      },
    });
    const notes: string[] = [];
    const runs = await collectRuns(client, window, 10_000, notes);
    expect(runs).toHaveLength(5000);
    expect(notes).toEqual(['Goby review runs truncated at 50 pages of 100']);
  });
});

describe('the options', () => {
  test('a repository comes from the flag or the environment the workflow already sets', () => {
    expect(options([], { GITHUB_REPOSITORY: 'owner/repo' }).repo).toBe('owner/repo');
    expect(options(['--repo', 'a/b'], {}).repo).toBe('a/b');
    expect(() => options([], {})).toThrow(/no repository/);
  });

  test('the window defaults to thirty days and the cap to something finite', () => {
    const opts = options(['--repo', 'a/b'], {});
    expect(opts.days).toBe(30);
    expect(opts.limit).toBe(2000);
    expect(options(['--repo', 'a/b', '--days', '7', '--limit', '50'], {}))
      .toMatchObject({ days: 7, limit: 50 });
  });

  test('a nonsense window falls back rather than returning nothing', () => {
    expect(options(['--repo', 'a/b', '--days', '0'], {}).days).toBe(30);
    expect(options(['--repo', 'a/b', '--days', 'soon'], {}).days).toBe(30);
  });
});

describe('the hints', () => {
  test('name fields, so a consumer starts from the shape rather than a query language', () => {
    expect(HINTS.length).toBeGreaterThan(4);
    expect(HINTS.every(hint => hint.includes('reviews[]') || hint.includes('issues[]') || hint.includes('runs[]'))).toBe(true);
    expect(HINTS.join(' ')).toContain('acted_on');
  });
});
