/**
 * The records `goby wake` hands a consumer, and the rules that decide what happened to a finding.
 *
 * Everything here is a pure function of what GitHub returns, so the shape a consumer builds a
 * view on can be tested without a server. The collecting is in `collect.ts`; this file is the
 * contract.
 *
 * The records are *facts about runs*, not answers about them. No medians, no totals across
 * records, no "health": a consumer that wants a graph groups these itself, and a new question
 * costs a new consumer rather than a new release of goby.
 */
import { MARKER } from '../identity.ts';
import { parseRecord } from '../core/record.ts';
import type { ThreadRecord } from '../platforms/github.ts';

/**
 * What became of a finding goby posted. Precision, deliberately: this classifies the findings
 * that were published, and says nothing about the ones goby never found.
 */
export type Outcome = 'acted_on' | 'disputed' | 'ignored' | 'superseded';

/** A short sha in a reply is the author saying which commit answered the finding. */
const NAMED_COMMIT = /\b([0-9a-f]{7,40})\b/i;

/**
 * The review's own marker, which carries goby's version on every review — including the ones
 * posted before the run record existed. `MARKER` is `goby`; the gate's marker is `goby-gate`, and
 * the required `head=` is what keeps the two apart.
 */
const REVIEW_MARKER = new RegExp(`<!--\\s*${MARKER}\\s+head=([0-9a-f]{7,})\\s+v=([^\\s>]+)`);

export interface ReviewFinding {
  path: string;
  line: number | null;
  severity: string | null;
  /** The line was changed after the comment, which is GitHub's answer for "this moved on". */
  outdated: boolean;
  outcome: Outcome;
  /** The commit a reply named, when it named one. */
  fix?: string;
}

export interface ReviewRecord {
  kind: 'review';
  pr: number;
  head: string;
  at: string;
  v: string | null;
  findings: ReviewFinding[];
  /**
   * The run marker's payload, or null for a review posted before the marker existed. */
  run: Record<string, unknown> | null;
  /** False when the thread list could not be read in full: the outcomes below are then a floor. */
  threads_complete: boolean;
}

export interface IssueRecord {
  kind: 'issue';
  number: number;
  product: string;
  v: string | null;
  title: string;
  state: string;
  /** `completed` (fixed), `not_planned` (dismissed), or null when GitHub reports neither. */
  state_reason: string | null;
  created_at: string;
  closed_at: string | null;
  age_days: number;
  path: string | null;
  severity: string | null;
  fingerprint: string;
}

export interface RunRecord {
  kind: 'run';
  product: string | null;
  workflow: string;
  event: string;
  conclusion: string | null;
  created_at: string;
  duration_s: number | null;
}

/**
 * One finding's outcome, from the thread that carries it.
 *
 * The order of these tests is the whole rule, and the reason `disputed` is its own bucket rather
 * than a false positive: the person replying "out of scope" is the author of the change, not a
 * neutral judge. Counting their answer as proof the finding was wrong would flatter the numbers,
 * and the flattering number is the one somebody would then put on a dashboard.
 */
export function classify(thread: Pick<ThreadRecord, 'outdated' | 'resolved' | 'resolution'>):
{ outcome: Outcome; fix?: string } {
  const reply = (thread.resolution ?? '').trim();
  if (thread.resolved) {
    const named = reply.match(NAMED_COMMIT);
    return named ? { outcome: 'acted_on', fix: named[1]!.toLowerCase() } : { outcome: 'acted_on' };
  }
  // Not resolved, and the line moved under it: a later commit rewrote what the finding described.
  if (thread.outdated) return { outcome: 'superseded' };
  if (reply) return { outcome: 'disputed' };
  return { outcome: 'ignored' };
}

export function reviewRecord(
  pr: number,
  review: { head: string; body: string; submitted_at: string },
  threads: readonly ThreadRecord[],
  threadsComplete: boolean,
): ReviewRecord {
  const marker = review.body.match(REVIEW_MARKER);
  const run = parseRecord(review.body);
  const short = review.head.slice(0, 10);
  // A thread belongs to the review whose commit it was opened against. Threads carry the short
  // sha goby wrote into them, which is why the comparison is on the prefix and not the whole sha.
  const own = threads.filter(thread => thread.sha === short || thread.sha === review.head);
  return {
    kind: 'review',
    pr,
    head: short,
    at: review.submitted_at,
    v: run?.v ?? marker?.[2] ?? null,
    findings: own.map(thread => ({
      path: thread.path,
      line: thread.line ?? thread.original_line ?? null,
      severity: thread.severity || null,
      outdated: thread.outdated,
      ...classify(thread),
    })),
    run: run ?? null,
    threads_complete: threadsComplete,
  };
}

/** The marker at the top of an issue: its fingerprint, which product filed it, and its fields. */
export function issueMarker(body: string): {
  product: string; fingerprint: string; fields: Record<string, string>;
} | null {
  const head = (body ?? '').replace(/^\s+/, '');
  const match = /^<!--\s+([A-Za-z0-9._-]+)\s+([^>]*?)-->/.exec(head);
  if (!match) return null;
  const fields: Record<string, string> = {};
  // Split on the next `key=`, not on every space: a path may contain one (`services/api v2/x.py`)
  // and a marker the reader cannot parse in full is a record with a truncated path in it.
  for (const pair of match[2]!.trim().split(/\s+(?=[a-z_]+=)/)) {
    const [key, ...rest] = pair.split('=');
    if (key && rest.length) fields[key] = rest.join('=');
  }
  if (!fields.fp) return null;
  return { product: match[1]!, fingerprint: fields.fp, fields };
}

export function issueRecord(issue: Record<string, any>, now: number): IssueRecord | null {
  const found = issueMarker(String(issue.body ?? ''));
  if (!found) return null;
  const created = String(issue.created_at ?? '');
  const created_ms = Date.parse(created);
  return {
    kind: 'issue',
    number: Number(issue.number) || 0,
    product: found.product,
    v: found.fields.v ?? null,
    title: String(issue.title ?? '').slice(0, 160),
    state: String(issue.state ?? ''),
    state_reason: issue.state_reason ?? null,
    created_at: created,
    closed_at: issue.closed_at ?? null,
    // Floor, not round: an issue filed this morning is 0 days old, which is what a human
    // reading a backlog means by "today".
    age_days: Number.isFinite(created_ms) ? Math.max(0, Math.floor((now - created_ms) / 86_400_000)) : 0,
    path: found.fields.path ?? found.fields.component ?? null,
    severity: found.fields.severity ?? null,
    fingerprint: found.fingerprint,
  };
}

/**
 * Which product a workflow run belongs to, from the name the workflow gives itself.
 *
 * The name has to *start* with goby and the product — `Goby review` — because a substring match
 * counts the repository's own tooling as product runs: this repository publishes an image from a
 * workflow called "review image" and tests one called "test review image", and counting those made
 * an image publish look like a scan that ran, its build time look like review time, and a failing
 * lint job look like a failed review. Coverage is the one number this tool exists to report
 * honestly.
 *
 * A consumer who renames the workflow gets `null`, not a guess: "unknown" is a fact, and a run
 * attributed to the wrong product is a measurement nobody can correct afterwards.
 */
export function runProduct(workflow: string): string | null {
  const match = /^goby[\s_-]+(review|cleaners|tide|wake)\b/i.exec(workflow.trim());
  return match ? match[1]!.toLowerCase() : null;
}

export function runRecord(run: Record<string, any>): RunRecord {
  const workflow = String(run.name ?? run.workflow_id ?? '');
  const started = Date.parse(String(run.run_started_at ?? run.created_at ?? ''));
  const ended = Date.parse(String(run.updated_at ?? ''));
  return {
    kind: 'run',
    product: runProduct(workflow),
    workflow: workflow.slice(0, 80),
    event: String(run.event ?? '').slice(0, 40),
    conclusion: run.conclusion ?? null,
    created_at: String(run.created_at ?? ''),
    duration_s: Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? Math.round((ended - started) / 1000) : null,
  };
}

/**
 * Somewhere to start, in plain English.
 *
 * Not a query language: a consumer that has to learn one has to learn what goby thinks is
 * interesting, and the point of printing records instead of answers is that it does not. These
 * name fields, so the reader can see what the shape is for and then do something else.
 */
export const HINTS = [
  'cost per review: reviews[].run.cost.cents, split by reviews[].at',
  'review duration: reviews[].run.agent_s, median per week',
  'share of time in the model: reviews[].run.model_s divided by reviews[].run.agent_s',
  'findings acted on: reviews[].findings[] where outcome is acted_on, over all findings',
  'findings disputed: reviews[].findings[] where outcome is disputed — not a false positive',
  'cost per finding acted on: reviews[].run.cost.cents divided by that count',
  'cleaners backlog: issues[] where product is goby-cleaners, grouped by state and age_days',
  'dismissals: issues[] where state_reason is not_planned, grouped by product',
  'coverage: runs[] where product is review, counted per day and conclusion',
  'release comparison: group reviews[], issues[] or runs[] by the v each record names, then place goby\'s tags on the axis',
];
