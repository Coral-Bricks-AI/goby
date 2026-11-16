/**
 * A one-file picture of the window, for a consumer who wants to look at the numbers without
 * building a view.
 *
 * The API's whole point is that drawing is the consumer's decision, so this is deliberately not a
 * dashboard: it is a single SVG written to a path when somebody asks for one, mostly so a person or
 * a one-off workflow can see what the records look like before deciding to store anything. It reads
 * the same object `wake` prints, so the picture and the JSON cannot disagree.
 *
 * What it draws is only what the records can carry honestly:
 *
 * - activity per day — reviews, and how many of those had findings;
 * - the outcome of those findings, which is the one number that is about quality rather than volume;
 * - for the reviews that carry a run marker, the money spent per day and the median time the agent
 *   took. The two go together on purpose: cost without duration is a quarter of a picture, and the
 *   days before the marker legitimately have neither, which is why the series can start mid-window.
 * - the issue backlog the two filing products left, split by what happened to each issue.
 *
 * No dependencies and no layout engine: a few hundred bytes of arithmetic over arrays, then a
 * string. Widths are fixed, because a picture whose size depends on its data is a picture that
 * shifts under a diff.
 */
import type { IssueRecord, ReviewRecord } from './records.ts';

export interface WakeBody {
  repo: string;
  /** goby's own version, as the JSON prints it. Absent in a record read by an older reader. */
  v?: string | null;
  generated_at: string;
  window: { since: string; days: number };
  counts: Record<string, number>;
  reviews: ReviewRecord[];
  issues: IssueRecord[];
  notes: string[];
}

const W = 360;
const PAD = 40;
const esc = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const day_of = (iso: string): string => (iso ?? '').slice(0, 10);
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Every day in the window, so a quiet day is a gap in the bars rather than a missing column. */
export function days(body: WakeBody): string[] {
  const out: string[] = [];
  const start = Date.parse(`${body.window.since.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${day_of(body.generated_at)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  // A window longer than a quarter is not a picture anybody reads at this width.
  const first = Math.max(start, end - 92 * 86_400_000);
  for (let at = first; at <= end; at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/** Count, or the median of a numeric field, per day. `null` where the day has nothing to say. */
function per_day<T>(body: WakeBody, rows: readonly T[], key: (row: T) => string,
                    value?: (row: T) => number | null): (number | null)[] {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const k = day_of(key(row));
    const v = value ? value(row) : 1;
    if (v === null || !Number.isFinite(v)) continue;
    buckets.set(k, [...(buckets.get(k) ?? []), v]);
  }
  return days(body).map(day => {
    const values = buckets.get(day);
    if (!values || !values.length) return value ? null : 0;
    return value ? median(values) : values.length;
  });
}

interface Geometry { x0: number; x1: number; top: number; height: number }

function bar_path(points: (number | null)[], geo: Geometry, peak: number, colour: string): string {
  const usable = Math.max(1, points.length);
  const step = (geo.x1 - geo.x0) / usable;
  const width = Math.max(1.5, step * 0.62);
  return points.map((value, index) => {
    if (!value) return '';
    const height = peak <= 0 ? 0 : (geo.height * value) / peak;
    const x = geo.x0 + step * index + (step - width) / 2;
    return `<rect x="${x.toFixed(1)}" y="${(geo.top + geo.height - height).toFixed(1)}" ` +
      `width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="${colour}"/>`;
  }).join('');
}

function line_path(points: (number | null)[], geo: Geometry, peak: number, colour: string): string {
  const usable = Math.max(1, points.length);
  const step = (geo.x1 - geo.x0) / usable;
  const at = points.map((value, index) => value === null ? null : [
    geo.x0 + step * index + step / 2,
    geo.top + geo.height - (peak <= 0 ? 0 : (geo.height * value) / peak),
  ] as const).filter((p): p is readonly [number, number] => p !== null);
  if (!at.length) return '';
  const path = at.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dots = at.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="${colour}"/>`).join('');
  return `<path d="${path}" fill="none" stroke="${colour}" stroke-width="1.5"/>${dots}`;
}

const legend = (x: number, y: number, items: [string, string][]): string => items
  .map(([colour, label], i) => `<rect x="${x + i * 108}" y="${y - 5}" width="6" height="6" fill="${colour}"/>` +
    `<text x="${x + i * 108 + 10}" y="${y}" font-size="7.5" fill="#555">${esc(label)}</text>`).join('');

const axis = (body: WakeBody, geo: Geometry): string => {
  const labels = days(body);
  if (!labels.length) return '';
  const usable = Math.max(1, labels.length);
  const step = (geo.x1 - geo.x0) / usable;
  const every = Math.ceil(usable / 7); // about seven ticks, however long the window
  return labels.map((label, index) => index % every ? '' :
    `<text x="${(geo.x0 + step * index + step / 2).toFixed(1)}" y="${geo.top + geo.height + 10}" ` +
    `font-size="6.5" fill="#888" text-anchor="middle">${label.slice(5)}</text>`).join('');
};

export function renderSvg(body: WakeBody): string {
  const reviews = body.reviews ?? [];
  const issues = body.issues ?? [];
  const marked = reviews.filter(review => review.run && review.run.measured !== false);

  const reviewsPerDay = per_day(body, reviews, review => review.at);
  const findingsPerDay = per_day(body, reviews.flatMap(review =>
    review.findings.map(finding => ({ at: review.at, outcome: finding.outcome }))),
  row => row.at, row => (row.outcome === 'acted_on' ? 1 : 0));
  // Cost and duration exist only where a run marker does: they are the two numbers that begin at a
  // release, and drawing a zero before that would claim a measurement nobody took.
  const centsPerDay = per_day(body, marked, review => review.at,
    review => Number((review.run?.cost as { cents?: unknown } | undefined)?.cents ?? NaN));
  const secondsPerDay = per_day(body, marked, review => review.at,
    review => Number(review.run?.agent_s ?? NaN));

  const states = [
    ['open', 'still open', '#8ab4f8'],
    ['completed', 'closed as fixed', '#8fd18f'],
    ['not_planned', 'closed as not planned', '#e8a2a2'],
  ] as const;
  const issueCounts = states.map(([reason]) => issues.filter(issue => reason === 'open'
    ? issue.state === 'open' : issue.state_reason === reason).length);

  const activity: Geometry = { x0: PAD, x1: W - PAD, top: 46, height: 86 };
  const money: Geometry = { x0: PAD, x1: W - PAD, top: 176, height: 86 };
  const peakReviews = Math.max(1, ...reviewsPerDay.map(v => v ?? 0), ...findingsPerDay.map(v => v ?? 0));
  const peakCents = Math.max(0.01, ...centsPerDay.map(v => v ?? 0));
  const peakSeconds = Math.max(1, ...secondsPerDay.map(v => v ?? 0));

  const totalIssues = issueCounts.reduce((sum, n) => sum + n, 0) || 1;
  let x = PAD;
  const backlog = states.map(([, , colour], index) => {
    const width = ((W - 2 * PAD) * issueCounts[index]!) / totalIssues;
    const rect = issueCounts[index] ? `<rect x="${x.toFixed(1)}" y="318" width="${width.toFixed(1)}" height="10" fill="${colour}"/>` : '';
    x += width;
    return rect;
  }).join('');

  const seconds = median(secondsPerDay.filter((v): v is number => v !== null));
  const notes = (body.notes ?? []).length
    ? `incomplete: ${body.notes.length} note(s) — see notes[] in the JSON`
    : 'complete window';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="372" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif">
<rect width="${W}" height="372" fill="#ffffff"/>
<text x="${PAD}" y="20" font-size="11" font-weight="600" fill="#111">goby wake — ${esc(body.repo)}</text>
<text x="${PAD}" y="32" font-size="7.5" fill="#777">${esc(body.window.since.slice(0, 10))} → ${esc(day_of(body.generated_at))} · ${reviews.length} reviews · ${issues.length} issues · v${esc(body.v ?? 'unknown')}</text>
<text x="${PAD}" y="${activity.top - 8}" font-size="7.5" fill="#555">reviews per day, and findings that were acted on</text>
${legend(PAD, activity.top + 4, [['#cfd8e3', 'reviews'], ['#166534', 'findings acted on']])}
${bar_path(reviewsPerDay, activity, peakReviews, '#cfd8e3')}
${line_path(findingsPerDay, activity, peakReviews, '#166534')}
${axis(body, activity)}
<text x="${PAD}" y="${money.top - 8}" font-size="7.5" fill="#555">spend per day (cents) and median minutes per review — ${marked.length} review(s) carry a run marker</text>
${legend(PAD, money.top + 4, [['#e5c79b', 'cents'], ['#b45309', seconds === null ? 'duration: none' : `median ${(seconds / 60).toFixed(1)} min`]])}
<line x1="${PAD}" y1="${money.top + money.height}" x2="${W - PAD}" y2="${money.top + money.height}" stroke="#eef1f5"/>
${bar_path(centsPerDay, money, peakCents, '#e5c79b')}
${line_path(secondsPerDay.map(v => v === null ? null : v), money, peakSeconds, '#b45309')}
${axis(body, money)}
<text x="${PAD}" y="306" font-size="7.5" fill="#555">the filing products' backlog</text>
${backlog}
${states.map(([, label, colour], index) => `<text x="${PAD + index * 108}" y="342" font-size="7" fill="#555"><tspan fill="${colour}">■</tspan> ${issueCounts[index]} ${esc(label)}</text>`).join('')}
<text x="${PAD}" y="360" font-size="6.5" fill="#999">${esc(notes)} · written ${esc(body.generated_at)} — nothing here is stored</text>
</svg>
`;
}
