import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { GitHubClient } from '../platforms/github.ts';
import { call_responses, extract_function_calls, extract_text } from '../providers/base.ts';
import { SYSTEM_PROMPT, build_user_prompt } from './contract.ts';
import { parse_hunks } from './diff.ts';
import { TurnBudget } from './rules.ts';

// These are the Python fetch-and-match bounds. Its byte-named budgets count
// Unicode characters, not encoded bytes; keep that behavior across the port.
export const READ_MAX_CHARS = 120_000;
export const LIST_MAX_ENTRIES = 500;
export const GREP_MAX_FILES = 200;
export const LISTING_CAP = 1000;
export const FILE_HISTORY_MAX = 10;
export const GREP_MAX_BYTES = 2_000_000;
export const GREP_MAX_MATCHES = 50;
export const GREP_MAX_LINE_CHARS = 400;
export const GREP_SCAN_TIME_S = 30;
export const PER_FILE_SCAN_S = 10;
export const FILE_CACHE_MAX_BYTES = 4_000_000;
export const CACHEABLE_FILE_BYTES = 512_000;
export const OVERSIZE_FETCH_MAX_BYTES = 16_000_000;
export const FORCED_FINAL_GRACE_S = 120;

export const AGENT_ADDENDUM = `You have tools to inspect the repository AT THE EXACT COMMIT UNDER REVIEW
before you report. Use them to verify what the diff suggests — read the
code around a change, check a caller, list a directory — instead of
guessing. The tools read only the reviewed commit.

- read_file(path, offset): contents of one file (truncated if very large;
  the truncation note names the next line — pass it as offset to read on).
- file_history(path): the recent commits that touched one file, newest
  first, as "sha date message" — use it to tell long-standing intended
  behavior from a bug this diff introduced.
- list_dir(path): entries of one directory; path "" is the repo root;
  direct children only, truncated if huge.
- grep(pattern, path, context_lines): regular-expression search, one match
  per line, as "path:line: text". context_lines (0-3) echoes that many
  surrounding lines around each match, indented — use it when you would
  otherwise follow the grep with a read_file to see the neighborhood.
  Without path it searches the files the diff touches;
  with a file path it searches that file; with a directory path it
  searches that directory RECURSIVELY — one call at a parent directory
  covers its whole subtree, so never walk subdirectories one call at a
  time. If a search reports it was truncated (too many files or bytes),
  narrow the path to a more specific subdirectory and search again.
  Results and the set of files scanned are bounded — a truncation
  note means you saw a prefix.

Call tools sparingly — a handful of targeted lookups, not a sweep. When
you are confident, or have looked enough, answer with the required output
format from your instructions and nothing else: your final message is
parsed as the findings array, so it must be exactly the \`\`\`json block.`;
export const FORCED_FINAL_INPUT = 'Budget exhausted. Report your findings now, in the required output '
  + 'format (exactly one ```json fenced block), based on what you have '
  + 'already seen. If you saw no bugs, output [].';
export const BUDGET_NOTE = 'NOTE: {remaining} of {max_tool_turns} tool turn(s) remaining. When you '
  + 'have enough context, stop calling tools and answer now with the '
  + 'required findings JSON block.';

const stringPath = { type: 'string', description: 'Repository-relative path.' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'function' as const, name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false }, strict: true,
});
export const TOOLS = [
  tool('read_file', "Read one file's contents at the reviewed commit. Large files truncate; call again with the next line's offset.", {
    path: stringPath, offset: { type: 'integer', description: '1-based line to start reading from.' },
  }, ['path']),
  tool('file_history', 'List recent commits touching one file (sha, date, message), newest first.', { path: stringPath }, ['path']),
  tool('list_dir', "List one directory's direct entries at the reviewed commit. Empty path is the root.", { path: stringPath }, []),
  tool('grep', 'Regex-search file contents at the reviewed commit. Without path searches changed files; a directory searches recursively. context_lines (0-3) echoes surrounding lines.', {
    pattern: { type: 'string', description: 'JavaScript regular expression (leading Python (?i), (?m), (?s) flags and named groups also supported).' },
    path: stringPath, context_lines: { type: 'integer', description: 'Surrounding lines to echo (0-3).' },
  }, ['pattern']),
];

const monotonic = () => performance.now() / 1000;
const length = (s: string) => Array.from(s).length;
const clip = (s: string, n: number) => Array.from(s).slice(0, n).join('');
const splitlines = (s: string) => {
  if (!s) return [];
  const lines = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const apiFailure = (e: unknown) => e instanceof Error && e.name === 'GitHubError';
class CacheFull extends Error {}

// Do not normalize a traversal into a valid path. No checkout, shell, URL,
// local file, or filesystem symlink resolution ever happens in this module.
// All content comes through GitHubClient at the pinned commit.
function safePath(value: unknown, allowRoot = false): string {
  if (value == null && allowRoot) return '';
  if (typeof value !== 'string') throw new Error('path must be a repository-relative string.');
  const path = value.trim();
  if (!path && allowRoot) return '';
  if (!path) throw new Error('path must be a non-empty repository-relative string.');
  let decoded = path;
  for (let i = 0; i < 8; i++) {
    if (/^[\/\\]|^[a-z][a-z0-9+.-]*:|[\\\x00-\x1f\x7f]/i.test(decoded)
        || decoded.split('/').some(p => p === '.' || p === '..' || p === '')) {
      throw new Error('unsafe path — use a repository-relative path without traversal.');
    }
    // Literal percent filenames remain usable, but encoded traversal and
    // separators are rejected even if a downstream API decodes them again.
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) return path;
    decoded = next;
  }
  throw new Error('unsafe path — excessive path encoding.');
}

/** Best-effort nested-quantifier guard; the killable worker is the hard bound. */
export function _risky_pattern(src: string): boolean {
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (ch === '(') {
      stack.push(false);
      if (src[i + 1] === '?') {
        const prefix = src.slice(i).match(/^\(\?(?:[:=!]|<[=!]|P<[^>]*>|<[^>]*>|[imsxauL-]+:?)/);
        if (prefix) i += prefix[0].length - 1;
      }
    } else if (ch === ')') {
      if (!stack.length) return false;
      const hasQuant = stack.pop()!;
      if (hasQuant && /^[*+?{]/.test(src.slice(i + 1))) return true;
      if (hasQuant && stack.length) stack[stack.length - 1] = true;
    } else if ('*+?'.includes(ch) || (ch === '{' && /^\{\d+(?:,\d*)?\}/.test(src.slice(i)))) {
      if (stack.length) stack[stack.length - 1] = true;
    }
  }
  return false;
}

function compilePattern(pattern: string): RegExp {
  // Common Python spellings port without changing the search intent. More
  // exotic Python constructs fail explicitly, never silently claim no matches.
  let flags = '';
  pattern = pattern.replace(/^\(\?([ims]+)\)/, (_, f: string) => { flags = f; return ''; });
  pattern = pattern.replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>')
    .replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>');
  return new RegExp(pattern, flags);
}

export interface ScanResult {
  matches: string[];
  match_count: number;
  lines_searched: number;
  timed_out: boolean;
  capped: boolean;
}

// Fixed, trusted worker source. Pattern and repository text are structured
// workerData, never executable source. A worker (not a Promise.race around
// RegExp.test on the main thread) can actually be terminated during ReDoS.
const SCAN_WORKER_SRC = String.raw`
const { parentPort, workerData: r } = require('node:worker_threads');
const rx = new RegExp(r.source, r.flags);
const lines = r.text ? r.text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/) : [];
if (lines.at(-1) === '') lines.pop();
let emitted = 0, trailTo = 0, capped = false, count = 0, searched = 0;
const recent = [];
const echo = (t, n, s) => parentPort.postMessage({t, l:n, v:r.path + ':' + n + ': ' + s.trim()});
for (let i = 0; i < lines.length; i++) {
  const n = i + 1, line = lines[i];
  const chars = Array.from(line);
  const shown = chars.length > r.lineMax ? chars.slice(0, r.lineMax).join('') + '…[line truncated for display]' : line;
  if (!capped && rx.test(line)) {
    count++;
    for (const [ln, tx] of recent) if (ln > emitted) { echo('c', ln, tx); emitted = ln; }
    echo('m', n, shown);
    emitted = n;
    trailTo = n + r.context;
    if (count + r.start >= r.maxMatches) capped = true;
  } else if (r.context && n <= trailTo && n > emitted) {
    echo('c', n, shown); emitted = n;
  }
  searched = n;
  if (r.context) { recent.push([n, shown]); if (recent.length > r.context) recent.shift(); }
  if (n % 1000 === 0) parentPort.postMessage({t:'p', l:n});
  if (capped && n >= trailTo) break;
}
parentPort.postMessage({t:'done', l:searched, capped});
`;

export async function _timed_scan(rx: RegExp, text: string, path: string, start_count: number,
  budget_s: number, context_lines = 0): Promise<ScanResult> {
  const result: ScanResult = { matches: [], match_count: 0, lines_searched: 0, timed_out: false, capped: false };
  return new Promise(resolve => {
    // Do not inherit --input-type/module loaders from a CLI/test host: the
    // trusted worker source is plain CommonJS in both Node and Bun.
    const worker = new Worker(SCAN_WORKER_SRC, { eval: true, execArgv: [], workerData: {
      source: rx.source, flags: rx.flags, text, path, start: start_count,
      maxMatches: GREP_MAX_MATCHES, lineMax: GREP_MAX_LINE_CHARS, context: context_lines,
    } });
    let terminating = false, settled = false;
    const finish = (incomplete: boolean) => {
      if (terminating) return;
      terminating = true;
      clearTimeout(timer);
      result.timed_out = incomplete;
      // Drain already-posted progress until exit, even on timeout. Abandoned
      // workers must not accumulate, nor may a kill discard earlier matches.
      const complete = () => { settled = true; resolve(result); };
      void worker.terminate().then(complete, complete);
    };
    const timer = setTimeout(() => finish(true), Math.max(budget_s, 0.01) * 1000);
    worker.on('message', (event: { t: string; l: number; v: string; capped: boolean }) => {
      if (settled) return;
      if (event.t === 'm') {
        result.matches.push(event.v);
        result.match_count++;
        result.lines_searched = Math.max(result.lines_searched, event.l);
      } else if (event.t === 'c') result.matches.push('  ' + event.v);
      else if (event.t === 'p' || event.t === 'done') result.lines_searched = Math.max(result.lines_searched, event.l);
      if (event.t === 'done') { result.capped = event.capped; finish(false); }
    });
    worker.on('error', () => finish(true));
    worker.on('exit', () => finish(true)); // No done record is inconclusive, even exit(0).
  });
}

export class ToolBox {
  readonly repo: string;
  readonly head_sha: string;
  readonly token: string;
  readonly diff_paths: string[];
  readonly enabled: boolean;
  readonly github: GitHubClient;
  private readonly unavailable_reason: string;
  private readonly cache = new Map<string, string>();
  private cache_bytes = 0;
  private oversize_bytes = 0;
  private tree: [string[], boolean] | null = null;
  private readonly dispatched = new Set<string>();
  private last_partial = false;
  private dispatch_tail: Promise<unknown> = Promise.resolve();

  constructor(repo: string, head_sha: string | null, token: string | null, diff: string, github?: GitHubClient) {
    this.repo = repo;
    this.head_sha = head_sha || '';
    this.token = token || '';
    const hunks = parse_hunks(diff);
    this.diff_paths = Object.keys(hunks).sort();
    this.github = github ?? new GitHubClient(repo, this.token);
    this.unavailable_reason = !this.head_sha || this.head_sha === 'local'
      ? 'local diff without --head-sha — there is no commit for the tools to read'
      : !this.token ? 'no GitHub token — pass one to let the tools read the pinned commit' : '';
    this.enabled = !this.unavailable_reason;
  }

  private unavailable(what: string): string { return `error: ${what} unavailable — ${this.unavailable_reason}.`; }

  private async file_text(path: string): Promise<string | null> {
    path = safePath(path);
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    if (this.cache_bytes >= FILE_CACHE_MAX_BYTES || this.oversize_bytes > OVERSIZE_FETCH_MAX_BYTES) throw new CacheFull();
    const text = await this.github.fetch_file(this.head_sha, path);
    if (text != null) {
      const n = length(text);
      if (n <= CACHEABLE_FILE_BYTES) { this.cache_bytes += n; this.cache.set(path, text); }
      else {
        this.oversize_bytes += n;
        if (this.oversize_bytes > OVERSIZE_FETCH_MAX_BYTES) throw new CacheFull();
      }
    }
    return text;
  }

  async read_file(path: unknown, offset: unknown = null): Promise<string> {
    if (!this.enabled) return this.unavailable('read_file');
    if (typeof path !== 'string' || !path.trim()) return 'error: read_file needs a non-empty string path.';
    if (offset != null && (!Number.isSafeInteger(offset) || (offset as number) < 1)) return 'error: offset must be a positive 1-based line number (or omitted).';
    const start = (offset as number | null) ?? 1;
    try {
      path = safePath(path);
      let text = await this.file_text(path as string);
      if (text == null) return `error: ${path} not found at this commit (or over 1MB, or a directory).`;
      if (start > 1) {
        const lines = splitlines(text);
        if (start > lines.length) return `error: ${path} has ${lines.length} line(s); offset ${start} is past the end.`;
        text = lines.slice(start - 1).join('\n');
      }
      if (length(text) <= READ_MAX_CHARS) return text;
      const shown = clip(text, READ_MAX_CHARS);
      const newlines = shown.split('\n').length - 1;
      const last = start + splitlines(text).length - 1;
      const next = start + newlines + (shown.endsWith('\n') ? 0 : 1);
      if (next > last) return shown + `\n\n[truncated at ${READ_MAX_CHARS} characters inside line ${last} — the line exceeds the read window and its remainder cannot be read with offsets]`;
      if (shown.endsWith('\n')) return shown + `\n\n[truncated at ${READ_MAX_CHARS} characters — the file continues at line ${next}; call read_file again with offset=${next} to read further]`;
      return shown + `\n\n[truncated at ${READ_MAX_CHARS} characters inside line ${next - 1} — the rest of that line is beyond the read window and is skipped; the file continues at line ${next}; call read_file again with offset=${next} to read further]`;
    } catch (e) {
      if (e instanceof CacheFull) return 'error: per-review file cache is full — be more targeted instead of reading another file.';
      return `error: ${apiFailure(e) ? 'GitHub API failure reading' : 'could not read'} ${path}: ${message(e)}`;
    }
  }

  async file_history(path: unknown): Promise<string> {
    if (!this.enabled) return this.unavailable('file_history');
    if (typeof path !== 'string' || !path.trim()) return 'error: file_history needs a non-empty string path.';
    try {
      path = safePath(path);
      const commits = await this.github.fetch_path_history(path as string, this.head_sha, FILE_HISTORY_MAX);
      if (!commits.length) return `no commits found touching ${path} at or below the reviewed commit.`;
      return commits.slice(0, FILE_HISTORY_MAX).map(c => `${c.sha.slice(0, 10)} ${c.date.slice(0, 10)} ${clip(splitlines(c.message)[0] || '', 100)}`).join('\n');
    } catch (e) { return `error: ${apiFailure(e) ? 'GitHub API failure fetching history for' : 'could not fetch history for'} ${path}: ${message(e)}`; }
  }

  async list_dir(path: unknown = ''): Promise<string> {
    if (!this.enabled) return this.unavailable('list_dir');
    try {
      path = safePath(path, true);
      const entries = await this.github.fetch_dir_listing(this.head_sha, path as string);
      if (entries == null) return `error: ${path || '<root>'} not found at this commit, or not a directory.`;
      if (!entries.length) return '(directory is empty)';
      return entries.slice(0, LIST_MAX_ENTRIES).map(e => `${e.name}${e.type === 'dir' ? '/' : ''}`).join('\n')
        + (entries.length > LIST_MAX_ENTRIES ? `\n[truncated at ${LIST_MAX_ENTRIES} entries]` : '');
    } catch (e) { return `error: ${apiFailure(e) ? 'GitHub API failure listing' : 'could not list'} ${path || '<root>'}: ${message(e)}`; }
  }

  private async repo_tree(): Promise<[string[], boolean]> {
    if (!this.tree) this.tree = await this.github.fetch_tree_paths(this.head_sha);
    return this.tree;
  }

  async repo_map(max_chars = 3000): Promise<string> {
    if (!this.enabled) return '';
    try {
      const [tree, truncated] = await this.repo_tree();
      const top = new Map<string, Set<string>>();
      for (const p of tree) {
        safePath(p);
        const parts = p.split('/');
        const parent = parts.length === 1 ? '' : parts[0];
        if (!top.has(parent)) top.set(parent, new Set());
        top.get(parent)!.add(parts.length === 1 ? parts[0] : parts[1]);
      }
      const lines: string[] = [];
      let size = 0, full = false;
      for (const name of [...top.keys()].sort()) {
        const children = [...top.get(name)!].sort();
        const entries = name ? [name + '/', ...children.map(c => '  ' + c)] : children;
        for (const entry of entries) {
          if (size + length(entry) + 1 > max_chars) { lines.push('…(layout truncated)'); full = true; break; }
          lines.push(entry); size += length(entry) + 1;
        }
        if (full) break;
      }
      return lines.join('\n') + (truncated ? '\n(GitHub truncated the tree listing; some paths missing)' : '');
    } catch { return ''; }
  }

  private async grep_scope(path: string): Promise<[string[], string]> {
    const bounded = (files: string[], label: string): [string[], string] => [files.slice(0, GREP_MAX_FILES), label
      + (files.length > GREP_MAX_FILES ? ` (truncated at ${GREP_MAX_FILES} files)` : '')];
    if (!path) return bounded(this.diff_paths, "the diff's changed files");
    let tree: string[], truncated: boolean;
    try { [tree, truncated] = await this.repo_tree(); }
    catch (e) {
      if (!apiFailure(e)) throw e;
      const listing = await this.github.fetch_dir_listing(this.head_sha, path);
      if (listing == null) return [[path], `file ${path}`];
      const files = listing.filter(e => e.type === 'file').map(e => `${path}/${safePath(e.name)}`);
      return bounded(files, `directory ${path} (direct files — recursive tree unavailable)`
        + (listing.length >= LISTING_CAP ? ` — listing may be truncated at GitHub's ${LISTING_CAP}-entry cap, coverage incomplete` : ''));
    }
    const subtree = tree.filter(p => p.startsWith(path + '/'));
    const files = subtree.length ? subtree : [path];
    return bounded(files, (subtree.length ? `directory ${path} (recursive)` : `file ${path}`)
      + (truncated ? ' — GitHub truncated the tree listing, paths beyond the cap were not searchable' : ''));
  }

  /** Overridable only for deterministic scan-budget tests, not a model tool. */
  protected scan_file(rx: RegExp, text: string, path: string, start: number, seconds: number, context: number): Promise<ScanResult> {
    return _timed_scan(rx, text, path, start, seconds, context);
  }

  async grep(pattern: unknown, path: unknown = '', context_lines: unknown = 0): Promise<string> {
    if (!this.enabled) return this.unavailable('grep');
    if (typeof pattern !== 'string' || !pattern) return 'error: grep needs a non-empty string pattern.';
    const context = context_lines ?? 0;
    if (!Number.isInteger(context) || (context as number) < 0 || (context as number) > 3) return 'error: context_lines must be an integer between 0 and 3.';
    if (_risky_pattern(pattern)) return 'error: pattern rejected — nested quantifiers (like (a+)+) can take exponential time; simplify the pattern.';
    let rx: RegExp;
    try { rx = compilePattern(pattern); } catch (e) { return `error: invalid regular expression: ${message(e)}`; }
    let files: string[], scope: string;
    try { path = safePath(path, true); [files, scope] = await this.grep_scope(path as string); }
    catch (e) { return `error: ${apiFailure(e) ? `GitHub API failure scoping grep to ${path || 'diff files'}` : 'could not scope grep'}: ${message(e)}`; }
    const matches: string[] = [], notes: string[] = [];
    let realMatches = 0, scanned = 0, missing = 0, incomplete = 0, byteSkipped = 0, bytes = 0;
    const started = monotonic();
    for (const file of files) {
      if (scanned >= GREP_MAX_FILES) {
        const remaining = files.length - scanned - missing - byteSkipped;
        if (remaining > 0) notes.push(`${remaining} file(s) not scanned`);
        break;
      }
      let text: string | null;
      try { text = await this.file_text(file); }
      catch (e) {
        notes.push(e instanceof CacheFull ? 'file cache full — remaining files not scanned'
          : `${apiFailure(e) ? 'GitHub API failure reading' : 'could not read'} ${file}: ${message(e)}`);
        break;
      }
      if (text == null) { missing++; continue; }
      const n = length(text);
      if (bytes + n > GREP_MAX_BYTES) { byteSkipped++; continue; }
      const remaining = GREP_SCAN_TIME_S - (monotonic() - started);
      if (remaining <= 0) { notes.push('scan-time cap reached — remaining files not scanned'); break; }
      const found = await this.scan_file(rx, text, file, realMatches, Math.min(remaining, PER_FILE_SCAN_S), context as number);
      if (found.lines_searched) { scanned++; bytes += n; }
      matches.push(...found.matches); realMatches += found.match_count;
      if (found.capped) notes.push(`match cap reached at ${GREP_MAX_MATCHES}`);
      if (found.timed_out) { notes.push(`${file} scan incomplete — per-file time cap`); incomplete++; }
      if (found.capped || realMatches >= GREP_MAX_MATCHES) break;
    }
    if (byteSkipped) notes.unshift(`${byteSkipped} file(s) fetched but skipped — byte cap`);
    let head = `searched ${scanned} file(s) in ${scope}`;
    if (missing) head += `; ${missing} unreadable (deleted or oversize)`;
    if (incomplete && scanned) head += `; ${incomplete} scan(s) incomplete`;
    this.last_partial = notes.length > 0;
    return head + '\n' + (matches.length ? matches.join('\n') : scanned === 0 && notes.length ? 'no files were searched' : 'no matches')
      + (notes.length ? `\n[${notes.join('; ')}]` : '');
  }

  async dispatch(name: unknown, args_json: unknown): Promise<string> {
    // Serialize dispatches so asynchronous partial results cannot poison a
    // concurrent call's duplicate key (and cache accounting stays ordered).
    const result = this.dispatch_tail.then(() => this.dispatch_one(name, args_json));
    this.dispatch_tail = result.catch(() => undefined);
    return result;
  }

  private async dispatch_one(name: unknown, args_json: unknown): Promise<string> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = args_json == null || args_json === '' ? {} : typeof args_json === 'string' ? JSON.parse(args_json) : args_json;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'error: arguments must be a JSON object.';
      args = parsed as Record<string, unknown>;
    } catch { return `error: arguments are not valid JSON: ${String(args_json).slice(0, 200)}`; }
    let key: string;
    try { key = `${String(name)} ${JSON.stringify(args, Object.keys(args).sort())}`; }
    catch { return 'error: arguments must be a JSON object.'; }
    if (this.dispatched.has(key)) return 'error: this exact call was already answered earlier in this review — its result is in the conversation above; vary the pattern or path if you need different information.';
    this.last_partial = false;
    try {
      let result: string;
      switch (name) {
        case 'read_file': result = await this.read_file(args.path, args.offset); break;
        case 'file_history': result = await this.file_history(args.path); break;
        case 'list_dir': result = await this.list_dir(args.path); break;
        case 'grep': result = await this.grep(args.pattern, args.path, args.context_lines); break;
        default: return `error: unknown tool ${String(name)} — use read_file, file_history, list_dir, or grep.`;
      }
      if (!result.startsWith('error:') && !this.last_partial) this.dispatched.add(key);
      return result;
    } catch (e) { return `error: tool execution failed: ${message(e)}`; }
  }
}

export interface AgentReply {
  content: string;
  /** Sum of model-turn latencies, not elapsed wall time. */
  elapsed_s: number;
  prompt_tokens: number;
  completion_tokens: number;
  turns: number;
  tool_calls: number;
  budget_exhausted: boolean;
  final_truncated: boolean;
  tool_counts: Record<string, number>;
}
export interface AgentOptions {
  api_key: string;
  model: string;
  base_url: string;
  session_id: string;
  repo: string;
  head_sha: string;
  token: string | null;
  diff: string;
  context: string;
  already_raised?: string[] | null;
  already_resolved?: string[] | null;
  pr_intent?: Parameters<typeof build_user_prompt>[4];
  max_tool_turns?: number;
  wall_timeout_s?: number;
  per_turn_timeout_s?: number;
  github?: GitHubClient;
  transport?: typeof call_responses;
  tools_exec?: { dispatch(name: string, args: string): string | Promise<string> };
  /** Monotonic seconds, sharing the transport's deadline_s epoch. */
  clock?: () => number;
}

export async function run_agent_review(opts: AgentOptions): Promise<AgentReply> {
  const maxTurns = opts.max_tool_turns ?? 10;
  const wall = opts.wall_timeout_s ?? 600;
  const perTurn = opts.per_turn_timeout_s ?? 300;
  // TurnBudget owns admission and validates cap/wall parameters. No duplicate
  // hand-written caps in this loop; even its first/final exceptions are rules.
  const budget = new TurnBudget(maxTurns, wall * 1000);
  if (!Number.isFinite(perTurn) || perTurn <= 0) throw new Error('per_turn_timeout_s must be positive and finite');
  const clock = opts.clock ?? monotonic;
  const toolbox = opts.tools_exec ?? new ToolBox(opts.repo, opts.head_sha, opts.token, opts.diff, opts.github);
  const instructions = SYSTEM_PROMPT + '\n\n' + AGENT_ADDENDUM;
  const repoMap = toolbox instanceof ToolBox && toolbox.enabled ? await toolbox.repo_map() : '';
  let nextInput: Parameters<typeof call_responses>[0]['input'] = build_user_prompt(opts.diff, opts.context,
    opts.already_raised ?? null, opts.already_resolved ?? null, opts.pr_intent ?? null, repoMap || null);
  const started = clock();
  let previous: string | null = null;
  const reply: AgentReply = { content: '', elapsed_s: 0, prompt_tokens: 0, completion_tokens: 0,
    turns: 0, tool_calls: 0, budget_exhausted: false, final_truncated: false, tool_counts: {} };
  const transport = opts.transport ?? call_responses;
  for (;;) {
    const admission = budget.take(Math.max(0, (clock() - started) * 1000));
    if (admission === 'stop') throw new Error('no final answer under budget');
    const final = admission === 'final';
    if (final) {
      reply.budget_exhausted = true;
      nextInput = Array.isArray(nextInput) ? [...nextInput, { role: 'user', content: FORCED_FINAL_INPUT }] : FORCED_FINAL_INPUT;
    }
    const timeout = final ? Math.min(perTurn, FORCED_FINAL_GRACE_S) : reply.turns === 0 ? perTurn
      : Math.min(perTurn, Math.max(0, wall - (clock() - started)));
    const turn = await transport({ api_key: opts.api_key, model: opts.model, base_url: opts.base_url,
      session_id: opts.session_id, input: nextInput, instructions, tools: final ? null : TOOLS,
      previous_response_id: previous, timeout_s: timeout, deadline_s: started + wall + (final ? FORCED_FINAL_GRACE_S : 0), clock });
    reply.turns++;
    reply.elapsed_s += turn.elapsed_s;
    reply.prompt_tokens += turn.input_tokens;
    reply.completion_tokens += turn.output_tokens;
    previous = turn.id || previous;
    const calls = final ? [] : extract_function_calls(turn.output);
    if (!calls.length) {
      const text = extract_text(turn.output);
      if (text == null) throw new Error(final ? 'no final answer under budget (model kept calling tools or returned no text)'
        : 'model turn produced neither tool calls nor text');
      reply.content = text;
      reply.final_truncated = turn.status === 'incomplete';
      return reply;
    }
    reply.tool_calls += calls.length;
    const outputs: Array<Record<string, unknown>> = [];
    for (const fc of calls) {
      const name = typeof fc.name === 'string' ? fc.name : '';
      const count = (Object.hasOwn(reply.tool_counts, name) ? reply.tool_counts[name] : 0) + 1;
      // A hostile tool name such as __proto__ remains an ordinary counter.
      Object.defineProperty(reply.tool_counts, name, { value: count, enumerable: true, writable: true });
      const args = typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments ?? {});
      const output = await toolbox.dispatch(name, args);
      outputs.push({ type: 'function_call_output', call_id: fc.call_id || fc.id || '', output });
    }
    outputs.push({ role: 'user', content: BUDGET_NOTE.replace('{remaining}', String(maxTurns - reply.turns)).replace('{max_tool_turns}', String(maxTurns)) });
    nextInput = outputs;
  }
}
