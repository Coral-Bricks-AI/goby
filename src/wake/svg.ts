/**
 * A one-file picture of the window, for a consumer who wants to look at the numbers without
 * building a view.
 *
 * The API's whole point is that drawing is the consumer's decision, so this is deliberately not a
 * dashboard: it is a single SVG written to a path when somebody asks for one, mostly so a person or
 * a one-off workflow can see what the records look like before deciding to store anything. It reads
 * the same object `wake` prints, so the picture and the JSON cannot disagree.
 *
 * Four panels, one per thing the records can answer, and each product drawn on its own because a
 * merged line across products answers nothing: a cleaners run and a review are not the same event.
 *
 * - **review** — reviews per day, the findings they carried, and how many were acted on;
 * - **review resource** — what those reviews cost and how long the agent took, from the runs that
 *   carry a run marker. The two belong together: cost without duration is a quarter of a question,
 *   and the days before the marker honestly have neither;
 * - **cleaners** and **tide** — filings per day, with the backlog they left running underneath;
 * - **runs** — every product's workflow runs, one strip per product, coloured by conclusion.
 *
 * Vertical lines mark the first day a new goby version appears in this repository's own records.
 * That is not the tag's date — the records carry a version, and the tag is a label a consumer can
 * join on — but it is the boundary the data itself shows, and it is the one that answers "did the
 * newer goby get faster".
 *
 * No dependencies and no layout engine: a few hundred bytes of arithmetic over arrays, then a
 * string. Widths are fixed, because a picture whose size depends on its data is a picture that
 * shifts under a diff.
 */
import type { IssueRecord, ReviewRecord, RunRecord } from './records.ts';

export interface WakeBody {
  repo: string;
  /** goby's own version, as the JSON prints it. Absent in a record read by an older reader. */
  v?: string | null;
  generated_at: string;
  window: { since: string; days: number };
  counts: Record<string, number>;
  reviews: ReviewRecord[];
  issues: IssueRecord[];
  runs: RunRecord[];
  notes: string[];
}


const W = 760;
const PAD = 64;
/** The plot area. The right margin holds the second axis of the cost panel and the run rows' room. */
const RIGHT = W - 104;
const PLOT = 74;
const TITLE = 22;
const GAP = 26;

const esc = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dayOf = (iso: string): string => (iso ?? '').slice(0, 10);
const round = (value: number): string => (Math.round(value * 10) / 10).toString();

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Every day in the window, so a quiet day is an empty column rather than a missing one. */
export function days(body: WakeBody): string[] {
  const out: string[] = [];
  const start = Date.parse(`${body.window.since.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${dayOf(body.generated_at)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  // A window longer than a quarter is not a picture anybody reads at this width.
  const first = Math.max(start, end - 91 * 86_400_000);
  for (let at = first; at <= end; at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/**
 * `count` is a count of rows and is 0 on a quiet day — nothing happened, which is a fact. `sum` and
 * `median` describe measurements and are null on a quiet day — nothing was observed, which is not
 * the same thing and must not be drawn as a zero.
 */
export type Aggregation = 'count' | 'sum' | 'median';

/** One series, aligned to the window's days. */
export function series<T>(body: WakeBody, rows: readonly T[], key: (row: T) => string,
                          value: (row: T) => number | null, how: Aggregation): (number | null)[] {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const found = value(row);
    if (found === null || !Number.isFinite(found)) continue;
    buckets.set(dayOf(key(row)), [...(buckets.get(dayOf(key(row))) ?? []), found]);
  }
  return days(body).map(day => {
    const found = buckets.get(day);
    if (!found?.length) return how === 'count' ? 0 : null;
    if (how === 'median') return median(found);
    return found.reduce((total, n) => total + n, 0);
  });
}

interface Geo { x0: number; x1: number; top: number; height: number }

const step = (geo: Geo, count: number): number => (geo.x1 - geo.x0) / Math.max(1, count);

function bars(points: (number | null)[], geo: Geo, peak: number, colour: string): string {
  const width = step(geo, points.length);
  return points.map((value, index) => {
    if (!value) return '';
    const height = peak <= 0 ? 0 : (geo.height * value) / peak;
    const bar = Math.max(1, width * 0.6);
    return `<rect x="${(geo.x0 + width * index + (width - bar) / 2).toFixed(1)}"` +
      ` y="${(geo.top + geo.height - height).toFixed(1)}" width="${bar.toFixed(1)}"` +
      ` height="${height.toFixed(1)}" rx="1" fill="${colour}"><title>${round(value)}</title></rect>`;
  }).join('');
}

function stacked(lower: (number | null)[], upper: (number | null)[], geo: Geo, peak: number,
                 below: string, above: string): string {
  const width = step(geo, lower.length);
  const bar = Math.max(1, width * 0.6);
  return lower.map((value, index) => {
    const bottom = value ?? 0;
    const top = Math.max(0, (upper[index] ?? 0));
    const heightOf = (n: number): number => (peak <= 0 ? 0 : (geo.height * n) / peak);
    const base = geo.top + geo.height;
    const first = heightOf(bottom);
    const second = heightOf(top);
    const x = (geo.x0 + width * index + (width - bar) / 2).toFixed(1);
    const drawn = [
      bottom ? `<rect x="${x}" y="${(base - first).toFixed(1)}" width="${bar.toFixed(1)}"` +
        ` height="${first.toFixed(1)}" fill="${below}"><title>${round(bottom)} without findings</title></rect>` : '',
      top ? `<rect x="${x}" y="${(base - first - second).toFixed(1)}" width="${bar.toFixed(1)}"` +
        ` height="${second.toFixed(1)}" fill="${above}"><title>${round(top)} with findings</title></rect>` : '',
    ].join('');
    return drawn;
  }).join('');
}

function line(points: (number | null)[], geo: Geo, peak: number, colour: string, dashed = false): string {
  const width = step(geo, points.length);
  const at = points.flatMap((value, index) => value === null ? [] : [[
    geo.x0 + width * index + width / 2,
    geo.top + geo.height - (peak <= 0 ? 0 : (geo.height * value) / peak),
  ] as const]);
  if (!at.length) return '';
  const path = at.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const values = points.filter((value): value is number => value !== null);
  return `<path d="${path}" fill="none" stroke="${colour}" stroke-width="${dashed ? 1.2 : 1.6}"` +
    `${dashed ? ' stroke-dasharray="4 2.5"' : ''}/>` +
    at.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.7" fill="${colour}">` +
      `<title>${round(values[i] ?? 0)}</title></circle>`).join('');
}

/**
 * Three gridlines and their numbers.
 *
 * The labels are de-duplicated after rounding, because a peak of 1 rendered "1, 1, 0" down the
 * side of the tide panel — a scale that repeats a number is a scale nobody can read.
 */
function yticks(geo: Geo, peak: number, format: (n: number) => string,
                side: 'left' | 'right' = 'left', colour = '#94a3b8'): string {
  if (peak <= 0) return '';
  const seen = new Set<string>();
  return [0, 0.5, 1].flatMap(fraction => {
    const label = format(peak * fraction);
    if (seen.has(label)) return [];
    seen.add(label);
    const y = geo.top + geo.height - geo.height * fraction;
    const x = side === 'left' ? geo.x0 - 8 : geo.x1 + 8;
    return [`<line x1="${geo.x0}" y1="${y.toFixed(1)}" x2="${geo.x1}" y2="${y.toFixed(1)}"` +
      ` stroke="${fraction === 0 ? '#c8d0d8' : '#eef1f5'}"/>` +
      `<text x="${x}" y="${(y + 3).toFixed(1)}" font-size="7.5" fill="${colour}"` +
      ` text-anchor="${side === 'left' ? 'end' : 'start'}">${esc(label)}</text>`];
  }).join('');
}

/** Legend on its own line, so it can never sit on top of a title or a note. */
const legend = (x: number, y: number, items: [string, string][]): string => items
  .map(([colour, label], index) => {
    const width = Math.max(52, label.length * 4.4 + 14);
    const offset = items.slice(0, index).reduce((sum, [, other]) => sum + Math.max(52, other.length * 4.4 + 14), 0);
    return `<rect x="${x + offset}" y="${y - 6}" width="7" height="7" rx="1" fill="${colour}"/>` +
      `<text x="${x + offset + 11}" y="${y}" font-size="8" fill="#475569">${esc(label)}</text>`;
  }).join('') + '';

/** The first day each goby version appears in this repository's own reviews, oldest first. */
export function milestones(body: WakeBody): { day: string; version: string }[] {
  const first = new Map<string, string>();
  for (const review of body.reviews ?? []) {
    if (!review.v || !review.at) continue;
    const day = dayOf(review.at);
    if (!first.has(review.v) || day < first.get(review.v)!) first.set(review.v, day);
  }
  return [...first.entries()].map(([version, day]) => ({ day, version }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.version.localeCompare(b.version));
}

/** Labels once, in the header: on every panel they landed on top of the previous panel's dates. */
function milestone_marks(body: WakeBody, tops: Geo[], label_y: number): string {
  const days_ = days(body);
  return milestones(body).map(({ day, version }) => {
    const index = days_.indexOf(day);
    // Day 0 is where the window starts, not where a release happened: a marker there draws a line
    // on top of the axis and labels a version the whole chart is already under.
    if (index <= 0 || !tops.length) return '';
    const x = tops[0]!.x0 + step(tops[0]!, days_.length) * index;
    return `<line x1="${x.toFixed(1)}" y1="${tops[0]!.top}" x2="${x.toFixed(1)}"` +
      ` y2="${(tops.at(-1)!.top + tops.at(-1)!.height).toFixed(1)}" stroke="#cbd5e1"` +
      ` stroke-dasharray="3 3"/>` +
      `<text x="0" y="0" font-size="7.5" fill="#64748b"` +
      ` transform="translate(${(x - 3).toFixed(1)} ${label_y}) rotate(-90)">${esc(version)}</text>`;
  }).join('');
}

/** Once, under the last panel: a date under each panel was a date colliding with the next title. */
function xaxis(body: WakeBody, geo: Geo): string {
  const labels = days(body);
  const width = step(geo, labels.length);
  const every = Math.max(1, Math.ceil(labels.length / 9));
  return labels.map((label, index) => index % every ? '' :
    `<text x="${(geo.x0 + width * index + width / 2).toFixed(1)}"` +
    ` y="${(geo.top + geo.height + 14).toFixed(1)}" font-size="8" fill="#94a3b8"` +
    ` text-anchor="middle">${label.slice(5)}</text>`).join('');
}

export function renderSvg(body: WakeBody): string {
  const reviews = body.reviews ?? [];
  const issues = body.issues ?? [];
  const runs = body.runs ?? [];
  const marked = reviews.filter(review => review.run);
  const findings = reviews.flatMap(review => review.findings.map(finding => ({ at: review.at, ...finding })));

  const quietPerDay = series(body, reviews.filter(review => !review.findings.length),
    review => review.at, () => 1, 'count');
  const noisyPerDay = series(body, reviews.filter(review => review.findings.length),
    review => review.at, () => 1, 'count');
  const reviewsPerDay = quietPerDay.map((n, i) => (n ?? 0) + (noisyPerDay[i] ?? 0));
  /**
   * The share of a day's findings that were acted on, as a percentage.
   *
   * Not a count, and not a median of a flag: a day with four findings of which three were acted on
   * is 75%. A day with no findings is null rather than 0% — no findings is not a failure to act on
   * them, and a flat line at zero was exactly the bug the first version shipped.
   */
  const pctActedPerDay = days(body).map(day => {
    const today = findings.filter(finding => dayOf(finding.at) === day);
    if (!today.length) return null;
    return (100 * today.filter(finding => finding.outcome === 'acted_on').length) / today.length;
  });
  const overallPct = findings.length
    ? Math.round((100 * findings.filter(f => f.outcome === 'acted_on').length) / findings.length)
    : null;
  const centsPerDay = series(body, marked, review => review.at,
    review => Number((review.run?.cost as { cents?: unknown } | undefined)?.cents ?? NaN), 'sum');
  const secondsPerDay = series(body, marked, review => review.at,
    review => (Number(review.run?.agent_s) / 60), 'median');

  const product = (name: string) => issues.filter(issue => issue.product.includes(name));
  const cleaners = product('cleaners');
  const tide = product('tide');
  const filings = (rows: IssueRecord[]) => series(body, rows, issue => issue.created_at, () => 1, 'count');
  /** Issues still open on a given day: filed by then, and not closed before it. */
  const backlog = (rows: IssueRecord[]) => days(body).map(day => rows.length
    ? rows.filter(issue => dayOf(issue.created_at) <= day &&
      (!issue.closed_at || dayOf(issue.closed_at) > day)).length
    : null);

  interface Panel {
    title: string; note: string; legend: [string, string][];
    draw: (geo: Geo) => string; extra?: (geo: Geo) => string;
  }

  const count = (n: number): string => String(Math.round(n));
  const panels: Panel[] = [
    {
      title: 'review',
      note: `${reviews.length} reviews · ` +
        `${reviews.length - noisyPerDay.reduce<number>((n, v) => n + (v ?? 0), 0)} found nothing · ` +
        `${findings.length} findings · ` +
        (overallPct === null ? 'none acted on' : `${overallPct}% acted on`),
      legend: [['#cfd8e3', 'reviews, no findings'], ['#8fa3bd', 'reviews with findings'],
        ['#166534', '% of findings acted on (right)']],
      draw: geo => {
        const peak = Math.max(1, ...reviewsPerDay.map(v => v ?? 0));
        return yticks(geo, peak, count) + stacked(quietPerDay, noisyPerDay, geo, peak, '#cfd8e3', '#8fa3bd');
      },
      extra: geo => yticks(geo, 100, n => `${Math.round(n)}%`, 'right', '#166534') +
        line(pctActedPerDay, geo, 100, '#166534', true),
    },
    {
      title: 'review resource',
      note: marked.length ? `${marked.length} reviews carry a run marker`
        : 'no review in this window carries a run marker',
      legend: [['#e5c79b', 'cents per day'], ['#b45309', 'median minutes (right)']],
      draw: geo => {
        const cents = Math.max(0.01, ...centsPerDay.map(v => v ?? 0));
        return yticks(geo, cents, n => `$${(n / 100).toFixed(2)}`) +
          bars(centsPerDay, geo, cents, '#e5c79b');
      },
      extra: geo => {
        const minutes = Math.max(0.1, ...secondsPerDay.map(v => v ?? 0));
        return yticks(geo, minutes, n => `${n.toFixed(1)}m`, 'right', '#b45309') +
          line(secondsPerDay, geo, minutes, '#b45309', true);
      },
    },
  ];

  const filingPanels: Panel[] = ([['cleaners', cleaners], ['tide', tide]] as const).map(([name, rows]) => ({
    title: name,
    note: `${rows.length} issues · ${rows.filter(issue => issue.state === 'open').length} still open`,
    legend: [['#8ab4f8', 'filed per day'], ['#7c3aed', 'open backlog']] as [string, string][],
    draw: (geo: Geo) => {
      const filed = filings(rows);
      const open = backlog(rows);
      const peak = Math.max(1, ...filed.map(v => v ?? 0), ...open.map(v => v ?? 0));
      return yticks(geo, peak, count) + bars(filed, geo, peak, '#8ab4f8') + line(open, geo, peak, '#7c3aed');
    },
  }));

  /**
   * Runs as a grid rather than bars: a run either happened and succeeded, happened and did not, or
   * did not happen, and three states read instantly as cells. Bars needed a per-row scale, which
   * made a two-run day look as tall as a forty-run one.
   */
  /**
   * Runs as a grid rather than bars: a day either ran and succeeded, ran and failed, was cancelled,
   * or did not run at all. Painting every non-success red was wrong — most of www's non-successes
   * are `cancelled` (the review workflow cancels superseded runs on the same pull request) and
   * `skipped` (drafts, forks, `no-review`), and a cancelled run is not a failed one.
   */
  const FAILED = ['failure', 'timed_out', 'startup_failure', 'action_required'];
  const runsPanel: Panel = {
    title: 'workflow runs',
    note: `${runs.length} runs · ` +
      `${runs.filter(run => FAILED.includes(String(run.conclusion))).length} failed`,
    legend: [['#166534', 'succeeded'], ['#b91c1c', 'failed'],
      ['#d97706', 'cancelled'], ['#eef1f5', 'did not run']],
    draw: geo => {
      const names = ['review', 'cleaners', 'tide', 'wake'].filter(name =>
        runs.some(run => run.product === name));
      if (!names.length) return `<text x="${geo.x0}" y="${geo.top + geo.height / 2}" font-size="8"` +
        ` fill="#94a3b8">no goby workflow runs in this window</text>`;
      const rowHeight = geo.height / names.length;
      const width = step(geo, days(body).length);
      const colourOf = (today: typeof runs): string => {
        const state = today.map(run => String(run.conclusion ?? 'running'));
        if (state.some(one => FAILED.includes(one))) return '#b91c1c';
        if (state.some(one => one === 'cancelled' || one === 'running')) return '#d97706';
        return state.every(one => one === 'skipped') ? '#e2e8f0' : '#166534';
      };
      return names.map((name, row) => {
        const mine = runs.filter(run => run.product === name);
        const cells = days(body).map((day, index) => {
          const today = mine.filter(run => dayOf(run.created_at) === day);
          const fill = today.length ? colourOf(today) : '#eef1f5';
          const counts = ['success', 'failure', 'cancelled', 'skipped']
            .map(conclusion => [conclusion,
              today.filter(run => String(run.conclusion ?? 'running') === conclusion).length] as const)
            .filter(([, n]) => n > 0).map(([conclusion, n]) => `${n} ${conclusion}`).join(', ');
          return `<rect x="${(geo.x0 + width * index + 1).toFixed(1)}"` +
            ` y="${(geo.top + rowHeight * row + 1).toFixed(1)}" width="${(width - 2).toFixed(1)}"` +
            ` height="${(rowHeight - 2).toFixed(1)}" fill="${fill}"><title>${esc(name)} ${day}: ` +
            `${counts || 'nothing'}</title></rect>`;
        }).join('');
        return cells + `<text x="${geo.x0 - 8}" y="${(geo.top + rowHeight * row + rowHeight / 2 + 3).toFixed(1)}"` +
          ` font-size="7.5" fill="#94a3b8" text-anchor="end">${esc(name)}</text>`;
      }).join('');
    },
  };

  const all = [...panels, ...filingPanels, runsPanel];
  const header = 66;
  const perPanel = TITLE + PLOT + GAP;
  const height = header + all.length * perPanel + 34;
  const geos: Geo[] = all.map((_, index) => ({
    x0: PAD, x1: RIGHT, top: header + index * perPanel + TITLE, height: PLOT,
  }));

  const drawn = all.map((panel, index) => {
    const geo = geos[index]!;
    const title_y = geo.top - 12;
    return `<text x="${PAD}" y="${title_y}" font-size="9.5" font-weight="600" fill="#334155">` +
      `${esc(panel.title)}</text>` +
      `<text x="${RIGHT}" y="${title_y}" font-size="8" fill="#94a3b8" text-anchor="end">${esc(panel.note)}</text>` +
      legend(PAD, geo.top - 1, panel.legend) +
      panel.draw(geo) + (panel.extra ? panel.extra(geo) : '');
  }).join('');

  const note = (body.notes ?? []).length
    ? `incomplete: ${body.notes.length} note(s) — see notes[] in the JSON`
    : 'complete window';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}"` +
    ` font-family="ui-sans-serif,system-ui,-apple-system,sans-serif">` +
    `<rect width="${W}" height="${height}" fill="#ffffff"/>` +
    `<text x="${PAD}" y="24" font-size="12.5" font-weight="600" fill="#0f172a">goby wake — ${esc(body.repo)}</text>` +
    `<text x="${PAD}" y="38" font-size="8.5" fill="#94a3b8">` +
    `${esc(dayOf(body.window.since))} → ${esc(dayOf(body.generated_at))} · ${esc(body.window.days)} days` +
    ` · v${esc(body.v ?? 'unknown')} · ${reviews.length} reviews · ${issues.length} issues · ${runs.length} runs</text>` +
    milestone_marks(body, geos, 52) +
    drawn + xaxis(body, geos.at(-1)!) +
    `<text x="${PAD}" y="${height - 10}" font-size="7.5" fill="#b0b8c4">` +
    `${esc(note)} · dashed lines: first day a goby version appears in this repository's reviews` +
    ` · written ${esc(body.generated_at)}, nothing here is stored</text>` +
    '</svg>\n';
}
