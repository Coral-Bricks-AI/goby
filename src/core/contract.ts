import { createHash } from 'node:crypto';

// Kept verbatim from the Python review contract.
export const SYSTEM_PROMPT = `You are a meticulous code reviewer. You review code changes (diffs) and report
ONLY actual bugs: logic errors, off-by-one, inverted conditions, wrong
variable, unhandled error paths, race conditions, resource leaks, security
issues, data corruption, crashes.

Hard rules:
- Report bugs introduced or exposed by this diff, not pre-existing issues the
  diff does not touch.
- Trace every changed value to where it is assigned and to every place it
  is consumed: read the surrounding code, not just the changed lines,
  before concluding.
- Before dismissing a suspected issue, identify the factual claims your
  dismissal depends on and verify each by reading the code. If the
  verification shows a claim false, report the finding rather than dismiss
  it. If the evidence you need could not be read at all (a read failed or
  came back truncated), do not report the suspicion either — an unverified
  guess is not a finding, in either direction.
- A change that breaks a documented workflow in the repository's AGENTS.md
  or CLAUDE.md (supplied as repository context below) is a finding — quote
  the rule it violates.
- Do NOT report style, naming, formatting, missing tests, documentation,
  performance micro-optimizations, or refactoring suggestions. Bugs only.
- If you are not confident something is a real bug, do not report it.
- Every finding must be concrete: what breaks, under what input or state.
- Before emitting your findings, re-walk the diff hunk by hunk and confirm
  every changed line was considered — do not stop at the first finding.
- Each array entry must be a bug you are affirmatively reporting. NEVER
  include an entry whose own reasoning retracts it — no "this is actually
  correct", "no bug", or "not reporting" entries. Finish your analysis
  first, then emit only the findings that survived it.

Output format — exactly one \`\`\`json fenced block, a JSON array, no prose
before or after it:

\`\`\`json
[
  {
    "path": "<file path as it appears in the diff>",
    "line": <1-based line number in the file AFTER the change>,
    "end_line": <optional: last line of the buggy span, same file, >= line;
                 the changed lines the bug spans when it covers a block.
                 Omit it for a single-line finding>,
    "severity": "high" | "medium" | "low",
    "title": "<one-line summary>",
    "detail": "<why this is a bug, what breaks, and the concrete fix>"
  }
]
\`\`\`

Severity scale: "high" = data loss or corruption, security exposure, a
crash, or user-visible breakage on a common path; "medium" = wrong
behavior on an edge case or under specific states; "low" = latent
defect, hard to trigger, or limited blast radius. When unsure between
two levels, pick the lower one.

If the diff introduces no bugs, output an empty array: []
`;

export const SEVERITY_RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };
export const PR_INTENT_MAX_CHARS = 4000;
export const REPHRASE_RATIO = 0.75;
export type Severity = 'high' | 'medium' | 'low';
export type Span = [number, number];
export interface FindingInput {
  path: string;
  line: number;
  severity: string;
  title: string;
  detail?: string;
  end_line?: number | null;
}
/** Optional fields let live, legacy-marker and resolved records share this API. */
export interface ThreadRecord {
  path?: string | null;
  line?: number | string | null;
  start_line?: number | string | null;
  original_line?: number | string | null;
  original_start_line?: number | string | null;
  marker_start?: number | string | null;
  marker_end?: number | string | null;
  fid?: string | null;
  title?: string | null;
  outdated?: boolean;
  created_at?: string;
  thread_id?: string;
  comment_id?: number | string;
}
// Python str.strip/isspace includes the C0 separators, but not JS's BOM.
const SPACE = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const trim = (s: string): string => s.replace(new RegExp(`^${SPACE}+|${SPACE}+$`, 'gu'), '');
const stripStars = (s: string): string => s.replace(/^\*+|\*+$/g, '');
const integer = (n: number): number => {
  if (!Number.isFinite(n)) throw new RangeError('cannot convert non-finite value to integer');
  return Math.trunc(n) || 0;
};

/** Data-only shape for serialization and publishers that do not need methods. */
export interface FindingRecord extends FindingInput {
  detail: string;
  end_line: number | null;
  fid: string;
}
export class Finding implements FindingRecord {
  path: string;
  line: number;
  severity: string;
  title: string;
  detail: string;
  end_line: number | null;
  fid: string;
  constructor({ path, line, severity, title, detail = '', end_line = null }: FindingInput) {
    this.path = path;
    this.line = line;
    this.severity = severity;
    this.title = title;
    this.detail = detail;
    this.end_line = Finding._norm_end_line(end_line, line);
    this.fid = this._compute_fid();
  }
  static _norm_end_line(end_line: number | null, line?: number | null): number | null {
    if (end_line === null || (line != null && end_line < line)) return null;
    return integer(end_line);
  }
  span(): Span { return [this.line, this.end_line ?? this.line]; }
  _compute_fid(): string {
    return createHash('sha1').update(`${this.path}\n${this.line}\n${trim(this.title).toLowerCase()}`, 'utf8').digest('hex').slice(0, 10);
  }
  rekey(): void { this.fid = this._compute_fid(); }
}

/** Python difflib.SequenceMatcher(None, a, b).ratio(), including autojunk,
 * earliest-match tie breaking and recursive matching-block partitioning.
 * Work on Unicode code points, not UTF-16 code units. */
export function _claim_similarity(a: string, b: string): number {
  const norm = (s: string): string[] => Array.from(trim(Array.from(trim(stripStars(trim(s))).toLowerCase())
    .filter(ch => /[\p{L}\p{N}]/u.test(ch) || new RegExp(`^${SPACE}$`, 'u').test(ch)).join('')));
  const left = norm(a), right = norm(b);
  const b2j = new Map<string, number[]>();
  right.forEach((ch, i) => { const indices = b2j.get(ch) ?? []; indices.push(i); b2j.set(ch, indices); });
  if (right.length >= 200) {
    const threshold = Math.floor(right.length / 100) + 1;
    for (const [ch, indices] of b2j) if (indices.length > threshold) b2j.delete(ch);
  }
  const queue: [number, number, number, number][] = [[0, left.length, 0, right.length]];
  let matches = 0;
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(left[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const size = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, size);
        if (size > bestsize) { besti = i - size + 1; bestj = j - size + 1; bestsize = size; }
      }
      j2len = next;
    }
    // No junk predicate: popular characters may extend the selected block.
    while (besti > alo && bestj > blo && left[besti - 1] === right[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && left[besti + bestsize] === right[bestj + bestsize]) bestsize++;
    if (bestsize) {
      matches += bestsize;
      if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
      if (besti + bestsize < ahi && bestj + bestsize < bhi) queue.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
    }
  }
  return left.length + right.length ? 2 * matches / (left.length + right.length) : 1;
}

export function thread_spans(t: ThreadRecord): Span[] {
  const spans: Span[] = [];
  let start = t.marker_start, end = t.marker_end;
  if (start == null) { start = t.original_start_line; end = t.original_line; }
  if (start == null) start = end = t.original_line;
  if (start == null) start = end = t.line;
  if (start != null) {
    const lo = integer(Number(start));
    spans.push([lo, end != null && integer(Number(end)) >= lo ? integer(Number(end)) : lo]);
  }
  if (t.line != null) {
    const cur = integer(Number(t.line));
    const lo = t.start_line != null ? integer(Number(t.start_line)) : cur;
    const span: Span = [Math.min(lo, cur), cur];
    if (!spans.some(([s, e]) => s <= span[0] && span[1] <= e)) spans.push(span);
  }
  return spans;
}
export function _spans_overlap(a: Span, b: Span): boolean { return a[0] <= b[1] && b[0] <= a[1]; }
export function _thread_covers(t: ThreadRecord, span: Span): boolean { return thread_spans(t).some(ts => _spans_overlap(ts, span)); }
export function format_thread_position(t: ThreadRecord): string {
  const path = t.path || '?';
  const start = t.marker_start ?? t.original_start_line ?? (Object.hasOwn(t, 'original_line') ? t.original_line : t.line);
  let out = `${path}:${start == null ? 'None' : start}`;
  // Python compares the integer end to the original (possibly string) start.
  if (t.marker_end && integer(Number(t.marker_end)) !== start) out += `-${t.marker_end}`;
  if (t.line != null && start != null && integer(Number(t.line)) !== integer(Number(start))) out += ` (now at ${path}:${integer(Number(t.line))})`;
  return out;
}
function partition<T>(items: readonly T[], withhold: (item: T) => boolean): [T[], T[]] {
  const fresh: T[] = [], withheld: T[] = [];
  for (const item of items) (withhold(item) ? withheld : fresh).push(item);
  return [fresh, withheld];
}
export function split_resolved_rederivations(findings: readonly Finding[], resolved_history: readonly ThreadRecord[] | null = null): [Finding[], Finding[]] {
  const ids = new Set((resolved_history ?? []).map(t => t.fid).filter(Boolean));
  const threads = (resolved_history ?? []).filter(t => thread_spans(t).length);
  return partition(findings, f => ids.has(f.fid) || threads.some(t => trim(t.path || '') === trim(f.path)
    && _thread_covers(t, f.span()) && _claim_similarity(f.title, t.title || '') >= REPHRASE_RATIO));
}

const SKIP_EXACT = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'cargo.lock', 'go.sum', 'flake.lock', 'composer.lock', 'Gemfile.lock']);
export function keep_path(path: string): boolean {
  return !SKIP_EXACT.has(path) && !['.lock', '.min.js', '.min.css', '.map'].some(s => path.endsWith(s))
    && !['datasets/', 'node_modules/', '.venv/', 'graphify-out/'].some(s => path.startsWith(s));
}
// Python's Unicode word boundaries include letters/numbers/underscore;
// JavaScript's \\b is ASCII-only even with the Unicode flag.
const STRONG = /(?<![\p{L}\p{N}_])(?:no bug|not a bug|isn'?t a bug|no defect|not a defect|no issue|not an issue|not reporting|no actual bug|not a real bug|false positive)(?![\p{L}\p{N}_])/giu;
const WEAK = /(?<![\p{L}\p{N}_])(?:by design|working as intended|works as intended|as intended|is intended|are intended|tests pass)(?![\p{L}\p{N}_])/giu;
const VERDICT_START = /^(?:(?:this|that|it|the code|the behavior|they) )?(?:(?:is |are |was )?(?:intended|by design)|(?:is |are |was )?(?:works |working )?as intended|tests pass)|^but tests pass\b/i;
const RESIDUE = /^(?:here|there|now|at all|this one|in this (?:file|case)|as an? (?:(?:definite|real|actual|separate|new|potential|possible) )?(?:bug|issue|defect|finding|problem))?$/i;
const TRAILING_PUNCT = new Set(Array.from(" \t\n\r.!?;:,)\\]}'\"—’”"));
function stripPunctuation(s: string): string {
  const chars = Array.from(s);
  while (chars.length && TRAILING_PUNCT.has(chars[0])) chars.shift();
  while (chars.length && TRAILING_PUNCT.has(chars[chars.length - 1])) chars.pop();
  return chars.join('');
}
export function _retraction_at_verdict(text: string): boolean {
  const segments = trim(text).split(new RegExp(`(?<=[.!?;:—])${SPACE}+`, 'u')).filter(s => trim(s));
  const last = segments.at(-1);
  if (!last) return false;
  for (const m of last.matchAll(STRONG)) if (RESIDUE.test(stripPunctuation(last.slice(m.index! + m[0].length)))) return true;
  for (const m of last.matchAll(WEAK)) {
    if (stripPunctuation(last.slice(m.index! + m[0].length))) continue;
    const before = last.slice(0, m.index).replace(/[ ,;]+$/g, '').toLowerCase();
    if (before.endsWith('but') || VERDICT_START.test(last.replace(new RegExp(`^${SPACE}+`, 'u'), ''))) return true;
  }
  return false;
}
export function drop_self_retracted(findings: readonly Finding[]): [Finding[], Finding[]] {
  return partition(findings, f => _retraction_at_verdict(f.title) || _retraction_at_verdict(f.detail));
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function _coerce_finding(entry: unknown): Finding | null {
  if (!isRecord(entry)) return null;
  const { path, line, title } = entry;
  if (typeof path !== 'string' || !trim(path) || typeof line !== 'number' || line < 1 || typeof title !== 'string' || !trim(title)) return null;
  const aliases: Record<string, string> = { critical: 'high', blocker: 'high', info: 'low', minor: 'low' };
  // Non-string values cannot spell a known severity in Python either. Avoid
  // invoking valueOf/toString on untrusted JSON objects (including null-prototype ones).
  let severity = typeof entry.severity === 'string' ? trim(entry.severity).toLowerCase() : '';
  severity = Object.hasOwn(aliases, severity) ? aliases[severity] : severity;
  if (!['high', 'medium', 'low'].includes(severity)) severity = 'medium';
  const end = typeof entry.end_line === 'number' && Number.isFinite(entry.end_line) ? integer(entry.end_line) : null;
  return new Finding({ path: trim(path), line: integer(line), severity, title: trim(title), detail: typeof entry.detail === 'string' ? trim(entry.detail) : '', end_line: end });
}

/** Decode one JSON value (also Python json's NaN/Infinity constants) without eval.
 * Returns the consumed boundary for raw_decode's trailing-prose fallback.
 * Numeric fields use JS numbers; integers beyond 2^53 lose Python precision. */
function rawDecode(text: string, start = 0): [unknown, number] {
  let i = start;
  const ws = () => { while (/[\t\n\r ]/.test(text[i] ?? '') && i < text.length) i++; };
  const parse = (): unknown => {
    const ch = text[i];
    if (ch === '"') {
      const begin = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') return JSON.parse(text.slice(begin, i));
      }
      throw new SyntaxError('Unterminated string');
    }
    if (ch === '[' || ch === '{') {
      const array = ch === '[', close = array ? ']' : '}';
      const values: unknown[] = [], object: Record<string, unknown> = Object.create(null);
      i++; ws();
      if (text[i] === close) { i++; return array ? values : object; }
      while (i < text.length) {
        if (array) values.push(parse());
        else {
          if (text[i] !== '"') throw new SyntaxError('Expected key');
          const key = parse() as string;
          ws(); if (text[i++] !== ':') throw new SyntaxError('Expected colon'); ws();
          object[key] = parse();
        }
        ws();
        if (text[i] === close) { i++; return array ? values : object; }
        if (text[i++] !== ',') throw new SyntaxError('Expected comma');
        ws();
      }
      throw new SyntaxError('Unterminated collection');
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]] as const) {
      if (text.startsWith(token, i)) { i += token.length; return value; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!number) throw new SyntaxError('Expected JSON value');
    i += number[0].length;
    return Number(number[0]);
  };
  const value = parse();
  return [value, i];
}
export function* _candidate_arrays(text: string): Generator<string | null> {
  const fenced = Array.from(text.matchAll(new RegExp('```(?:json)?' + SPACE + '*(.*?)```', 'gsu')), m => m[1]);
  yield* fenced.reverse();
  let best: string | null = null;
  let count = 0;
  for (let i = 0; i < text.length && count < 50; i++) {
    if (text[i] !== '[') continue;
    count++;
    try {
      const [obj, end] = rawDecode(text, i);
      if (Array.isArray(obj) && obj.length && obj.every(isRecord)) best = text.slice(i, end);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  yield best;
}
export interface ParseOptions { strict?: boolean }
export function parse_findings(text: string, options: ParseOptions | boolean = {}): Finding[] | null {
  const strict = typeof options === 'boolean' ? options : options.strict ?? false;
  if (trim(text) === '[]') return [];
  for (const candidate of _candidate_arrays(text)) {
    if (!candidate) continue;
    let parsed: unknown;
    try {
      const source = trim(candidate);
      const [value, end] = rawDecode(source);
      if (end !== source.length) throw new SyntaxError('Extra data');
      parsed = value;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (strict) return null;
      continue;
    }
    if (!Array.isArray(parsed)) { if (strict) return null; continue; }
    const findings: Finding[] = [], seen = new Set<string>();
    for (const entry of parsed) {
      let f: Finding | null;
      try { f = _coerce_finding(entry); }
      catch (error) { if (strict && (error instanceof RangeError || error instanceof TypeError)) return null; throw error; }
      if (f === null) { if (strict) return null; continue; }
      const key = JSON.stringify([f.path, f.line, f.title.toLowerCase()]);
      if (seen.has(key)) continue;
      seen.add(key); findings.push(f);
    }
    return findings;
  }
  return null;
}
export function dedupe_findings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = JSON.stringify([f.path, f.line, f.title.toLowerCase()]);
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, f);
    else if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[cur.severity]) cur.severity = f.severity;
  }
  const out = Array.from(byKey.values());
  out.forEach(f => f.rekey());
  return out;
}
export function split_already_raised(findings: readonly Finding[], open_threads: readonly ThreadRecord[]): [Finding[], Finding[]] {
  const raised = open_threads.filter(t => !t.outdated && thread_spans(t).length);
  return partition(findings, f => raised.some(t => trim(t.path || '') === trim(f.path) && _thread_covers(t, f.span())));
}
export function plan_thread_resolution<T extends ThreadRecord>(open_threads: readonly T[]): [T, string][] {
  const out: [T, string][] = [], byLine = new Map<string, T[]>();
  for (const t of open_threads) {
    if (t.outdated) out.push([t, 'Superseded: the commented line changed in a newer head. The review re-flags this finding at its new position if it still applies; if not, this thread stays as history.']);
    else if (t.line != null) {
      const key = JSON.stringify([t.path, t.line]);
      const group = byLine.get(key) ?? []; group.push(t); byLine.set(key, group);
    }
  }
  for (const group of byLine.values()) {
    group.sort((a, b) => (a.created_at ?? '') < (b.created_at ?? '') ? -1 : (a.created_at ?? '') > (b.created_at ?? '') ? 1 : 0);
    for (const t of group.slice(1)) out.push([t, 'Duplicate: this position already has an open Goby Review thread — the oldest one stays, this copy is resolved.']);
  }
  return out;
}
export function select_findings<T extends { severity: string }>(findings: readonly T[], max_findings: number): [T[], number] {
  const rank = (severity: string): number => Object.hasOwn(SEVERITY_RANK, severity) ? SEVERITY_RANK[severity] : 1;
  const ranked = [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  return [ranked.slice(0, max_findings), Math.max(0, ranked.length - max_findings)];
}
export interface PrIntent { title?: string | null; body?: string | null }
export function build_user_prompt(diff: string, repo_context: string, already_raised: readonly string[] | null = null,
  already_resolved: readonly string[] | null = null, pr_intent: PrIntent | null = null, repo_map: string | null = null): string {
  const parts = ['Review the following code change for bugs, following the output', 'format from your instructions exactly.'];
  if (pr_intent && (trim(pr_intent.title || '') || trim(pr_intent.body || ''))) {
    let body = trim(pr_intent.body || '(no description)');
    if (Array.from(body).length > PR_INTENT_MAX_CHARS) body = Array.from(body).slice(0, PR_INTENT_MAX_CHARS).join('') + '\n…(description truncated)';
    parts.push('', "## The author's stated intent for this change", '', `**Title:** ${pr_intent.title || '(none)'}`, '', body, '',
      '(Intent ends. Use it to tell intended behavior from bugs — do', "NOT report the change's stated purpose as a finding, and do not", 'assume intent the description does not state.)');
  }
  if (trim(repo_context)) parts.push('', '## Repository context', '', trim(repo_context), '',
    '(Context ends. It describes repo conventions — do not report its', 'contents as findings.)');
  if (repo_map && trim(repo_map)) parts.push('', '## Repository layout (top two levels)', '', trim(repo_map), '',
    '(Layout ends. Use these real paths to scope searches — a grep', 'scoped to the right directory costs one call instead of a walk.)');
  if (already_raised?.length) parts.push('', '## Findings already raised on this PR — do NOT re-report them', '', ...already_raised, '',
    'Each position above already has an open review thread — the', 'line shown, plus its whole span when a range like `12-18` is',
    'listed. Do not include these in your output, and do not', 're-derive the same bug at an adjacent line to get around it.', 'Report only NEW bugs at other positions.');
  if (already_resolved?.length) parts.push('', '## Findings previously raised on this PR and already resolved', '', ...already_resolved, '',
    'Each line above was raised in an earlier review round and the', 'thread was resolved — fixed, or explained as not a bug (the',
    'resolution says which). Do not re-derive or re-report the same', 'claim without checking the current diff: re-litigating a',
    'resolved thread is a false positive. If this diff genuinely', 'reintroduces a resolved bug, report it — a finding at the same',
    'position is listed in the review summary for a human to see,', 'not posted as a new thread. Otherwise report only bugs', 'not in the list above.');
  parts.push('', '## The diff to review', '', '```diff', diff, '```', '', 'Report only bugs introduced by the diff above. Line numbers are',
    '1-based in the file AFTER the change. Output the ```json block now.');
  return parts.join('\n');
}
