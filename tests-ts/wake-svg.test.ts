import { describe, expect, test } from 'bun:test';
import { days, milestones, renderSvg, series, type WakeBody } from '../src/wake/svg.ts';
import { options } from '../src/wake/main.ts';
import type { IssueRecord, ReviewRecord } from '../src/wake/records.ts';

const review = (changes: Partial<ReviewRecord> = {}): ReviewRecord => ({
  kind: 'review', pr: 1, head: 'deadbeef00', at: '2026-11-14T10:00:00Z', v: '0.5.0',
  findings: [], run: null, threads_complete: true, ...changes,
});

const issue = (changes: Partial<IssueRecord> = {}): IssueRecord => ({
  kind: 'issue', number: 1, product: 'goby-cleaners', v: '0.5.0', title: 'x', state: 'open',
  state_reason: null, created_at: '2026-11-10T00:00:00Z', closed_at: null, age_days: 4,
  path: 'src', severity: 'high', fingerprint: '0123456789ab', ...changes,
});

const body = (changes: Partial<WakeBody> = {}): WakeBody => ({
  schema: 1, product: 'wake', v: '0.5.0', generated_at: '2026-11-16T07:00:00Z',
  repo: 'owner/repo', window: { since: '2026-11-14T00:00:00Z', days: 3 },
  counts: { reviews: 1, findings: 0, issues: 1, runs: 0 },
  reviews: [review()], issues: [issue()], runs: [], hints: [], notes: [],
  ...changes,
} as WakeBody);

describe('the picture', () => {
  test('is a well-formed svg that stands alone', () => {
    const svg = renderSvg(body());
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // No external references: a file that needs the network is not a file you can keep.
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('href=');
  });

  test('a count series sums, so "acted on" is not a median of a flag', () => {
    // The first version took the median of an outcome flag per day — 0 or 1 — and drew a flat line
    // on the floor while 71 findings had been acted on. Counts sum; only measurements take a median.
    const rows = [{ at: '2026-11-14T01:00:00Z', n: 1 }, { at: '2026-11-14T02:00:00Z', n: 1 },
      { at: '2026-11-15T02:00:00Z', n: 1 }];
    expect(series(body(), rows, r => r.at, r => r.n, 'count')).toEqual([2, 1, 0]);
    expect(series(body(), rows.map(r => ({ ...r, n: 0.5 })), r => r.at, r => r.n, 'median'))
      .toEqual([0.5, 0.5, null]);
    // A measurement nobody took is null, not zero: the difference between "spent nothing" and
    // "spend unknown".
    expect(series(body(), rows, r => r.at, r => r.n, 'sum')).toEqual([2, 1, null]);
  });

  test('separates the products, because a merged line across them answers nothing', () => {
    const svg = renderSvg(body({
      issues: [issue(), issue({ number: 2, product: 'goby-tide', state: 'closed', state_reason: 'completed' })],
    }));
    for (const title of ['review', 'review resource', 'cleaners', 'tide', 'workflow runs']) {
      expect(svg).toContain(`>${title}</text>`);
    }
    expect(svg).toContain('1 still open');
    expect(svg).toContain('0 still open');
  });

  test('marks the day each version first appears, because that is the axis with a question on it', () => {
    const svg = renderSvg(body({
      reviews: [review({ pr: 1, at: '2026-11-14T10:00:00Z', v: '0.5.0' }),
        review({ pr: 2, at: '2026-11-15T10:00:00Z', v: '0.5.1' }),
        review({ pr: 3, at: '2026-11-16T10:00:00Z', v: '0.5.1' })],
    }));
    expect(milestones(body({ reviews: [] }))).toEqual([]);
    const marks = milestones(body({
      reviews: [review({ at: '2026-11-14T10:00:00Z', v: '0.5.0' }),
        review({ at: '2026-11-16T10:00:00Z', v: '0.5.1' }),
        review({ at: '2026-11-15T10:00:00Z', v: '0.5.1' })],
    }));
    expect(marks).toEqual([{ day: '2026-11-14', version: '0.5.0' }, { day: '2026-11-15', version: '0.5.1' }]);
    expect(svg).toContain('stroke-dasharray="3 3"');
    // The version on day 0 is where the window starts, not a release boundary: a line there sits
    // on the axis and labels a version every point is already under.
    expect(svg).not.toContain('0.5.0</text>');
    expect(svg).toContain('0.5.1</text>');
  });

  test('never draws a measurement that is not there', () => {
    // A review with no run marker has no cost and no duration. Drawing a zero would be a number
    // nobody took, which is the one thing the records are careful about.
    const svg = renderSvg(body({ reviews: [review(), review({ pr: 2 })] }));
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
    expect(svg).toContain('no review in this window carries a run marker');
    expect(svg).toContain('no review in this window carries a run marker');
  });

  test('draws cost and duration once a run marker exists', () => {
    const svg = renderSvg(body({ reviews: [review({
      run: { schema: 1, product: 'review', v: '0.5.0', complete: true, model: 'm', measured: true,
        agent_s: 120, cost: { cents: 4.5, usd: 0.045, note: null } },
    })] }));
    expect(svg).toContain('1 reviews carry a run marker');
  });

  test('an empty window renders rather than throwing', () => {
    const svg = renderSvg(body({ reviews: [], issues: [], counts: { reviews: 0, findings: 0, issues: 0, runs: 0 } }));
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('0 reviews');
  });

  test('escapes what a repository name may contain', () => {
    const svg = renderSvg(body({ repo: 'a/<script>&b' }));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('a/&lt;script&gt;&amp;b');
  });

  test('says when the window is not the whole window', () => {
    expect(renderSvg(body({ notes: ['reviews truncated at 5'] }))).toContain('1 note(s)');
    expect(renderSvg(body())).toContain('complete window');
  });

  test('every day in the window is a column, so a quiet day is a gap and not a missing one', () => {
    const spanned = days(body());
    expect(spanned).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    // A window longer than a quarter is clamped: nobody reads 300 columns at this width.
    expect(days(body({ window: { since: '2025-01-01T00:00:00Z', days: 700 } })).length).toBeLessThanOrEqual(93);
  });

  test('a window longer than the chart draws does not invent quiet reviews', () => {
    // `days()` clamps to the last 91 days, and the note subtracted the drawn "with findings" from
    // the *undrawn* total — so a 93-day request claimed 1 review found nothing when both had
    // findings. Every count in the note is about the rows the panels actually draw.
    const acted = [{ path: 'a.ts', line: 1, severity: 'high', outdated: false, outcome: 'acted_on' as const }];
    const long = body({
      window: { since: '2026-08-16T00:00:00Z', days: 93 },
      reviews: [review({ pr: 1, at: '2026-08-16T00:00:00Z', findings: acted }),
        review({ pr: 2, at: '2026-11-15T10:00:00Z', findings: acted })],
    });
    const note = renderSvg(long).match(/(\d+) reviews? · (\d+) found nothing · (\d+) findings?/)!;
    expect(Number(note[2])).toBe(0);
    expect(renderSvg(long)).toContain('showing the last');
    // And inside the drawn window the same rows are reported in full.
    const short = body({ reviews: [review({ pr: 2, at: '2026-11-15T10:00:00Z', findings: acted })] });
    expect(renderSvg(short)).not.toContain('showing the last');
  });

  test('is small enough to keep and to log', () => {
    const many = Array.from({ length: 60 }, (_, i) => review({
      pr: i, at: `2026-11-${String(10 + (i % 7)).padStart(2, '0')}T10:00:00Z`,
      findings: [{ path: 'a.ts', line: 1, severity: 'high', outdated: false, outcome: 'acted_on' }],
    }));
    expect(renderSvg(body({ reviews: many })).length).toBeLessThan(24 * 1024);
  });
});

describe('the flag', () => {
  test('writes nothing unless asked', () => {
    expect(options(['--repo', 'a/b'], {}).svg).toBeNull();
  });

  test('takes a path, or the environment, and refuses a bare flag', () => {
    expect(options(['--repo', 'a/b', '--svg', '/tmp/wake.svg'], {}).svg).toBe('/tmp/wake.svg');
    expect(options(['--repo', 'a/b'], { GOBY_WAKE_SVG: '/tmp/x.svg' }).svg).toBe('/tmp/x.svg');
    // A bare `--svg` is a mistake, not "write somewhere sensible".
    expect(() => options(['--repo', 'a/b', '--svg'], {})).toThrow(/--svg needs a path/);
  });
});
