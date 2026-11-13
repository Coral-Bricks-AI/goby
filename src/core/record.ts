/**
 * The run marker: one run's numbers, in the review body that already records the run.
 *
 * Why it exists at all. The numbers a review produces about itself — cost, tokens, turns, the
 * model-versus-tools split, the per-request distribution — were printed to the Actions job
 * summary. That summary has no API, and it expires with the log, so "what does a review cost"
 * was answerable for ninety days out of a zip. The pull request keeps its body forever, and it
 * already carries two markers (`<!-- goby … -->` for the review, `<!-- goby-gate … -->` for the
 * receipt). This is the third: the same numbers, where they outlive the log.
 *
 * The envelope is here rather than in the writer because two programs need it: `runrecord.py`
 * measures the fields, this file wraps them, and a reader unwraps them. One grammar, three users.
 *
 * Size is part of the contract. The per-call array `timing.py` can emit is deliberately absent —
 * it is already in the log, and a marker that carried it would add tens of kilobytes to every
 * review anyone reads. `test_runrecord.py` holds the writer to a two-kilobyte bound.
 */

/** Marks a run record inside a body. `<!-- goby-run {...} -->`, one per review. */
export const RECORD_PREFIX = '<!-- goby-run ';

/**
 * What a record's fields mean. Versioned because a consumer groups by these fields: the count of
 * findings acted on, the median `agent_s`, the sum of `cost.cents`.
 *
 * `complete` is the publisher's answer, not the stream's: a review cut short by its budget or by
 * a killed command was fast for the wrong reason, and an average that mixes those with finished
 * runs reports a system that is fast because it gave up. `timeouts` counts the killed commands;
 * `complete` says whether the scan itself finished.
 *
 * Every measurement may be `null`: absent and zero are different claims, and a stated zero is a
 * measurement nobody took.
 */
export interface RunRecord {
  schema: number;
  product: string;
  /** goby's own version, so a view can put release tags on the x-axis instead of commit shas. */
  v: string | null;
  complete: boolean;
  model: string | null;
  /** False when the run produced no event stream: the fields below are then absent, not zero. */
  measured: boolean;
  note?: string;
  agent_s?: number | null;
  model_s?: number | null;
  tools_s?: number | null;
  other_s?: number | null;
  turns?: number;
  tool_calls?: number;
  tool_s?: Record<string, number>;
  requests?: { count: number; p50_s: number | null; p95_s: number | null; max_s: number | null };
  timeouts?: number;
  blocked?: string | null;
  tokens?: {
    input: number; output: number; cache_read: number; cache_write: number; reasoning: number;
  };
  cost?: { cents: number | null; usd: number | null; note: string | null };
  [field: string]: unknown;
}

/**
 * An HTML comment ends at the first `-->`, and a JSON string may contain one. Escaping the angle
 * bracket keeps the comment intact and leaves the value unchanged once parsed: `\u003e` is a `>`
 * to every JSON reader, and `--\u003e` is not a comment terminator to GitHub.
 */
function escapeComment(json: string): string { return json.replace(/-->/g, '--\\u003e'); }

export function recordMarker(record: RunRecord): string {
  return `${RECORD_PREFIX}${escapeComment(JSON.stringify(record))} -->`;
}

/**
 * The record a body carries, or null.
 *
 * Null covers every "cannot read it": no marker, two markers, malformed JSON, a schema this
 * reader does not know. A reader that guessed at a half-parsed record would report a number the
 * run never produced.
 */
export function parseRecord(body: string): RunRecord | null {
  const lines = (body ?? '').split(/\r?\n/).filter(line => line.startsWith(RECORD_PREFIX));
  if (lines.length !== 1) return null;
  const line = lines[0]!.trimEnd();
  if (!line.endsWith(' -->')) return null;
  try {
    const data: unknown = JSON.parse(line.slice(RECORD_PREFIX.length, -4));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    if (typeof record.schema !== 'number' || typeof record.product !== 'string') return null;
    return record as RunRecord;
  } catch { return null; }
}
