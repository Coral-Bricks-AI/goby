import { describe, expect, test } from 'bun:test';
import { days, renderSvg, type WakeBody } from '../src/wake/svg.ts';
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

  test('never draws a measurement that is not there', () => {
    // A review with no run marker has no cost and no duration. Drawing a zero would be a number
    // nobody took, which is the one thing the records are careful about.
    const svg = renderSvg(body({ reviews: [review(), review({ pr: 2 })] }));
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
    expect(svg).toContain('duration: none');
    expect(svg).toContain('2 review(s) carry a run marker'.replace('2', '0'));
  });

  test('draws cost and duration once a run marker exists', () => {
    const svg = renderSvg(body({ reviews: [review({
      run: { schema: 1, product: 'review', v: '0.5.0', complete: true, model: 'm', measured: true,
        agent_s: 120, cost: { cents: 4.5, usd: 0.045, note: null } },
    })] }));
    expect(svg).toContain('1 review(s) carry a run marker');
    expect(svg).toContain('median 2.0 min');
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
