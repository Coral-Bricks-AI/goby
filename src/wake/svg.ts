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

const W = 700;
const PAD = 52;
const RIGHT = W - 128;
const PANEL = 78;
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

/**
 * One series, aligned to the window's days.
 *
 * Counts aggregate as sums and only the measured values — cost, duration — take a median. Mixing
 * the two was a real bug in the first version: a median over an outcome flag is 0 or 1, so "findings
 * acted on" drew a flat line on the floor while 71 findings had in fact been acted on.
 */
export function series<T>(body: WakeBody, rows: readonly T[], key: (row: T) => string,
                          value: (row: T) => number | null, how: Aggregation): (number | null)[] {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const found = value(row);
    if (found === null || !Number.isFinite(found)) continue;
    const day = dayOf(key(row));
    buckets.set(day, [...(buckets.get(day) ?? []), found]);
  }
  return days(body).map(day => {
    const found = buckets.get(day);
    if (!found?.length) return how === 'count' ? 0 : null;
    if (how === 'median') return median(found);
    return found.reduce((total, n) => total + n, 0);
  });
}

interface Geo { x0: number; x1: number; top: number; height: number }

function step(geo: Geo, count: number): number { return (geo.x1 - geo.x0) / Math.max(1, count); }

function bars(points: (number | null)[], geo: Geo, peak: number, colour: string): string {
  const width = Math.max(1, step(geo, points.length) * 0.6);
  return points.map((value, index) => {
    if (!value) return '';
    const height = peak <= 0 ? 0 : (geo.height * value) / peak;
    return `<rect x="${(geo.x0 + step(geo, points.length) * index + (step(geo, points.length) - width) / 2).toFixed(1)}"` +
      ` y="${(geo.top + geo.height - height).toFixed(1)}" width="${width.toFixed(1)}"` +
      ` height="${height.toFixed(1)}" fill="${colour}"><title>${round(value)}</title></rect>`;
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
  return `<path d="${path}" fill="none" stroke="${colour}" stroke-width="${dashed ? 1 : 1.4}"` +
    `${dashed ? ' stroke-dasharray="3 2"' : ''}/>` +
    at.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5" fill="${colour}">` +
      `<title>${round(points.filter(p => p !== null)[i] ?? 0)}</title></circle>`).join('');
}

/** Two gridlines and their numbers: enough to read a magnitude, few enough not to shout. */
function yticks(geo: Geo, peak: number, format: (n: number) => string): string {
  if (peak <= 0) return '';
  return [0, 0.5, 1].map(fraction => {
    const y = geo.top + geo.height - geo.height * fraction;
    return `<line x1="${geo.x0}" y1="${y.toFixed(1)}" x2="${geo.x1}" y2="${y.toFixed(1)}"` +
      ` stroke="${fraction === 0 ? '#c8d0d8' : '#eef1f5'}"/>` +
      `<text x="${geo.x0 - 6}" y="${(y + 2.5).toFixed(1)}" font-size="6.5" fill="#888"` +
      ` text-anchor="end">${esc(format(peak * fraction))}</text>`;
  }).join('');
}

const legend = (x: number, y: number, items: [string, string][]): string => items
  .map(([colour, label], index) => `<rect x="${x + index * 130}" y="${y - 5}" width="6" height="6" fill="${colour}"/>` +
    `<text x="${x + index * 130 + 9}" y="${y}" font-size="7" fill="#555">${esc(label)}</text>`).join('');

function xaxis(body: WakeBody, geo: Geo): string {
  const labels = days(body);
  const width = step(geo, labels.length);
  const every = Math.max(1, Math.ceil(labels.length / 9));
  return labels.map((label, index) => index % every ? '' :
    `<text x="${(geo.x0 + width * index + width / 2).toFixed(1)}" y="${geo.top + geo.height + 11}"` +
    ` font-size="6.5" fill="#999" text-anchor="middle">${label.slice(5)}</text>`).join('');
}

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

function milestone_lines(body: WakeBody, geo: Geo, label: boolean): string {
  const days_ = days(body);
  return milestones(body).map(({ day, version }) => {
    const index = days_.indexOf(day);
    if (index < 0) return '';
    const x = geo.x0 + step(geo, days_.length) * index;
    return `<line x1="${x.toFixed(1)}" y1="${geo.top}" x2="${x.toFixed(1)}" y2="${geo.top + geo.height}"` +
      ` stroke="#b0b8c4" stroke-dasharray="2 2"/>` +
      (label ? `<text x="${(x + 2).toFixed(1)}" y="${geo.top - 3}" font-size="6.5" fill="#8a94a6">` +
        `${esc(version)}</text>` : '');
  }).join('');
}

export function renderSvg(body: WakeBody): string {
  const reviews = body.reviews ?? [];
  const issues = body.issues ?? [];
  const runs = body.runs ?? [];
  const marked = reviews.filter(review => review.run);
  const findings = reviews.flatMap(review =>
    review.findings.map(finding => ({ at: review.at, ...finding })));

  const reviewsPerDay = series(body, reviews, review => review.at, () => 1, 'count');
  const findingsPerDay = series(body, findings, finding => finding.at, () => 1, 'count');
  const actedPerDay = series(body, findings.filter(finding => finding.outcome === 'acted_on'),
    finding => finding.at, () => 1, 'count');
  const centsPerDay = series(body, marked, review => review.at,
    review => Number((review.run?.cost as { cents?: unknown } | undefined)?.cents ?? NaN), 'sum');
  const secondsPerDay = series(body, marked, review => review.at,
    review => Number(review.run?.agent_s ?? NaN), 'median');

  const product = (name: string) => issues.filter(issue => issue.product.includes(name));
  const cleaners = product('cleaners');
  const tide = product('tide');

  /** Issues still open on a given day: filed before it, and not closed before it. */
  const backlog = (rows: IssueRecord[]): (number | null)[] => days(body).map(day => {
    const open = rows.filter(issue => dayOf(issue.created_at) <= day &&
      (!issue.closed_at || dayOf(issue.closed_at) > day)).length;
    return rows.length ? open : null;
  });
  const filings = (rows: IssueRecord[]) => series(body, rows, issue => issue.created_at, () => 1, 'count');

  const conclusions = ['success', 'failure', 'cancelled', 'skipped'];
  const runRow = (name: string) => {
    const rows = runs.filter(run => run.product === name);
    return conclusions.map(conclusion => ({
      conclusion,
      points: series(body, rows.filter(run => String(run.conclusion) === conclusion),
        run => run.created_at, () => 1, 'count'),
    }));
  };

  const panels: {
    title: string; note: string; legend: [string, string][];
    draw: (geo: Geo) => string;
  }[] = [
    {
      title: 'review', note: `${reviews.length} reviews, ${findings.length} findings` +
        ` · ${findings.filter(f => f.outcome === 'acted_on').length} acted on`,
      legend: [['#cfd8e3', 'reviews'], ['#94a3b8', 'findings'], ['#166534', 'acted on']],
      draw: geo => {
        const peak = Math.max(1, ...reviewsPerDay.map(v => v ?? 0), ...findingsPerDay.map(v => v ?? 0));
        return yticks(geo, peak, n => String(Math.round(n))) + bars(reviewsPerDay, geo, peak, '#cfd8e3') +
          line(findingsPerDay, geo, peak, '#94a3b8') + line(actedPerDay, geo, peak, '#166534');
      },
    },
    {
      title: 'review resource', note: marked.length
        ? `${marked.length} reviews carry a run marker`
        : 'no review in this window carries a run marker',
      legend: [['#e5c79b', 'cents/day'], ['#b45309', 'median minutes/day']],
      draw: geo => {
        const cents = Math.max(0.01, ...centsPerDay.map(v => v ?? 0));
        const seconds = Math.max(1, ...secondsPerDay.map(v => v ?? 0));
        return yticks(geo, cents, n => `$${(n / 100).toFixed(2)}`) +
          bars(centsPerDay, geo, cents, '#e5c79b') +
          line(secondsPerDay, geo, seconds, '#b45309', true);
      },
    },
  ];

  const issuePanels = ([['cleaners', cleaners], ['tide', tide]] as const).map(([name, rows]) => ({
    title: name,
    note: `${rows.length} issues · ${rows.filter(issue => issue.state === 'open').length} still open`,
    legend: [['#8ab4f8', 'filed'], ['#7c3aed', 'open backlog']] as [string, string][],
    draw: (geo: Geo) => {
      const filed = filings(rows);
      const peak = Math.max(1, ...filed.map(v => v ?? 0), ...backlog(rows).map(v => v ?? 0));
      return yticks(geo, peak, n => String(Math.round(n))) + bars(filed, geo, peak, '#8ab4f8') +
        line(backlog(rows), geo, peak, '#7c3aed');
    },
  }));

  const runPanel = {
    title: 'workflow runs',
    note: `${runs.length} runs`,
    legend: [['#166534', 'success'], ['#b91c1c', 'not']] as [string, string][],
    draw: (geo: Geo) => {
      const names = ['review', 'cleaners', 'tide', 'wake'];
      const rowHeight = geo.height / names.length;
      return names.map((name, row) => {
        const rows = runRow(name);
        const peak = Math.max(1, ...rows.flatMap(series => series.points.map(v => v ?? 0)));
        const top = geo.top + rowHeight * row;
        const inner = { ...geo, top, height: rowHeight - 3 };
        const ok = rows.find(series => series.conclusion === 'success')!.points;
        const bad = rows.filter(series => series.conclusion !== 'success')
          .reduce<number[]>((acc, series) => acc.map((n, i) => n + (series.points[i] ?? 0)),
            ok.map(() => 0));
        return `<text x="${geo.x0 - 6}" y="${(top + rowHeight / 2).toFixed(1)}" font-size="6" fill="#888"` +
          ` text-anchor="end">${esc(name)}</text>` +
          bars(ok, inner, peak, '#166534') + bars(bad, inner, peak, '#b91c1c');
      }).join('');
    },
  };

  const all = [...panels, ...issuePanels, runPanel];
  const header = 44;
  const height = header + all.length * (PANEL + 26) + 26;
  let top = header;
  const drawn = all.map(panel => {
    const geo: Geo = { x0: PAD, x1: RIGHT, top: top + 12, height: PANEL };
    const block = `<text x="${PAD}" y="${top}" font-size="8.5" font-weight="600" fill="#334155">` +
      `${esc(panel.title)}</text>` +
      `<text x="${RIGHT}" y="${top}" font-size="7" fill="#94a3b8" text-anchor="end">${esc(panel.note)}</text>` +
      legend(PAD, top + 11, panel.legend) +
      milestone_lines(body, geo, true) + panel.draw(geo) + xaxis(body, geo);
    top += PANEL + 26;
    return block;
  }).join('');

  const note = (body.notes ?? []).length
    ? `incomplete: ${body.notes.length} note(s) — see notes[] in the JSON`
    : 'complete window';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}"` +
    ` font-family="ui-sans-serif,system-ui,-apple-system,sans-serif">` +
    `<rect width="${W}" height="${height}" fill="#ffffff"/>` +
    `<text x="${PAD}" y="22" font-size="12" font-weight="600" fill="#0f172a">` +
    `goby wake — ${esc(body.repo)}</text>` +
    `<text x="${PAD}" y="35" font-size="7.5" fill="#94a3b8">` +
    `${esc(dayOf(body.window.since))} → ${esc(dayOf(body.generated_at))} · ${esc(body.window.days)} days` +
    ` · v${esc(body.v ?? 'unknown')} · ${reviews.length} reviews · ${issues.length} issues` +
    ` · ${runs.length} runs</text>` +
    drawn +
    `<text x="${PAD}" y="${height - 10}" font-size="6.5" fill="#b0b8c4">` +
    `${esc(note)} · dashed lines: first day a goby version appears in this repository's reviews` +
    ` · written ${esc(body.generated_at)}, nothing here is stored</text>` +
    '</svg>\n';
}
