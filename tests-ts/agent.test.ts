import { describe, expect, test } from 'bun:test';
import {
  AGENT_ADDENDUM, BUDGET_NOTE, CACHEABLE_FILE_BYTES, FILE_CACHE_MAX_BYTES,
  FILE_HISTORY_MAX, FORCED_FINAL_GRACE_S, FORCED_FINAL_INPUT, GREP_MAX_BYTES,
  GREP_MAX_FILES, GREP_MAX_MATCHES, LISTING_CAP, LIST_MAX_ENTRIES,
  OVERSIZE_FETCH_MAX_BYTES, READ_MAX_CHARS, TOOLS, ToolBox, _risky_pattern,
  _timed_scan, run_agent_review, type AgentOptions, type ScanResult,
} from '../src/core/agent.ts';
import { GitHubClient, GitHubError } from '../src/platforms/github.ts';
import type { CallResponsesOptions, ResponsesTurn } from '../src/providers/base.ts';
import { TurnBudget } from '../src/core/rules.ts';

const findings = '```json\n[]\n```';
const diffFor = (...paths: string[]) => paths.map(p => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`).join('');
const fc = (name = 'read_file', id = 'c1', args = '{"path":"a.py"}') => ({ type: 'function_call', name, call_id: id, id: `item_${id}`, arguments: args });
const msg = (text = findings) => ({ type: 'message', content: [{ type: 'output_text', text }] });

class FakeProvider {
  calls: CallResponsesOptions[] = [];
  onCall?: (index: number) => void;
  constructor(readonly script: Array<unknown[] | { output: unknown[]; status: string; id?: string }>) {}
  transport = async (opts: CallResponsesOptions): Promise<ResponsesTurn> => {
    this.calls.push(opts);
    const i = this.calls.length - 1;
    this.onCall?.(i);
    const entry = this.script[i];
    if (!entry) throw new Error('unexpected extra model call');
    return { id: !Array.isArray(entry) && entry.id !== undefined ? entry.id : `resp_${i + 1}`,
      output: Array.isArray(entry) ? entry : entry.output, status: Array.isArray(entry) ? 'completed' : entry.status,
      elapsed_s: 0.01, input_tokens: 10, output_tokens: 5 };
  };
}
class FakeTools {
  dispatched: [string, string][] = [];
  async dispatch(name: string, args: string) { this.dispatched.push([name, args]); return `answer:${name}`; }
}
const run = (provider: FakeProvider, options: Partial<AgentOptions> = {}) => run_agent_review({
  api_key: 'k', model: 'm', base_url: 'http://invalid.test', session_id: 's', repo: 'o/r',
  head_sha: 'deadbeef', token: 'tok', diff: diffFor('a.py'), context: '', already_raised: [],
  tools_exec: new FakeTools(), transport: provider.transport, clock: () => 1000, ...options,
});
const batch = (p: FakeProvider, n: number) => p.calls[n].input as Record<string, unknown>[];
// What turn n actually added: the model's own items plus this turn's tool
// outputs. The request input is always the whole replayed conversation.
const appended = (p: FakeProvider, n: number) => batch(p, n).slice(n === 0 ? 0 : batch(p, n - 1).length);
const toolOutputs = (p: FakeProvider, n: number) => appended(p, n).filter(item => item.type === 'function_call_output');

class FakeGitHub extends GitHubClient {
  files: Record<string, string | null>;
  tree: [string[], boolean];
  listings = new Map<string, {name: string; type: string}[] | null>();
  history: {sha: string; date: string; message: string}[] = [];
  reads: [string, string][] = [];
  trees: string[] = [];
  dirs: [string, string][] = [];
  histories: [string, string, number][] = [];
  failFile: string | undefined;
  failTree = false;
  failListing = false;
  constructor(files: Record<string, string | null> = {}) {
    super('o/r', 'tok', { fetch: Object.assign(async () => { throw new Error('unexpected network'); }, { preconnect() {} }) });
    this.files = files;
    this.tree = [Object.keys(files).sort(), false];
  }
  override async fetch_file(ref: string, path: string): Promise<string | null> {
    this.reads.push([ref, path]);
    if (this.failFile === path) throw new GitHubError(502, '/contents', 'unavailable');
    return this.files[path] ?? null;
  }
  override async fetch_tree_paths(ref: string): Promise<[string[], boolean]> {
    this.trees.push(ref);
    if (this.failTree) throw new GitHubError(502, '/git/trees', 'unavailable');
    return this.tree;
  }
  override async fetch_dir_listing(ref: string, path: string) {
    this.dirs.push([ref, path]);
    if (this.failListing) throw new GitHubError(502, '/contents', 'unavailable');
    return this.listings.get(path) ?? null;
  }
  override async fetch_path_history(path: string, ref: string, limit = 10) {
    this.histories.push([path, ref, limit]); return this.history;
  }
}
function box(files: Record<string, string | null> = {}, paths = Object.keys(files)) {
  const github = new FakeGitHub(files);
  return { github, tools: new ToolBox('o/r', 'deadbeef', 'tok', diffFor(...paths), github) };
}

describe('agent response loop', () => {
  test('one direct answer has the public result shape and no tools executed', async () => {
    const p = new FakeProvider([[msg()]]);
    const result = await run(p);
    expect(result).toEqual({ content: findings, elapsed_s: 0.01, prompt_tokens: 10, completion_tokens: 5,
      turns: 1, tool_calls: 0, budget_exhausted: false, final_truncated: false, tool_counts: {} });
    expect(JSON.stringify(p.calls[0].input)).toContain('diff --git');
    expect(p.calls[0].tools).toEqual(TOOLS);
    expect('previous_response_id' in p.calls[0]).toBe(false);
  });

  test('replays the conversation, repeats instructions, accounts tokens and each tool', async () => {
    const p = new FakeProvider([[fc(), fc('grep', 'c2', '{"pattern":"x"}')], [fc('grep', 'c3')], [msg()]]);
    const tools = new FakeTools();
    const r = await run(p, { tools_exec: tools });
    expect(r.turns).toBe(3); expect(r.tool_calls).toBe(3);
    expect(r.tool_counts).toEqual({ read_file: 1, grep: 2 });
    expect(r.elapsed_s).toBeCloseTo(0.03);
    expect(r.prompt_tokens).toBe(30); expect(r.completion_tokens).toBe(15);
    expect(p.calls.every(c => !('previous_response_id' in c))).toBe(true);
    expect(p.calls.every(c => c.instructions?.includes(AGENT_ADDENDUM))).toBe(true);
    // The prompt is sent once and resent verbatim; each turn only appends its
    // own items and its tool outputs.
    expect(batch(p, 1)).toHaveLength(6); expect(batch(p, 2)).toHaveLength(9);
    expect(appended(p, 1)[0]).toEqual(fc());
    expect(batch(p, 2)[0]).toEqual(batch(p, 1)[0]);
    expect(toolOutputs(p, 1)).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'answer:read_file' },
      { type: 'function_call_output', call_id: 'c2', output: 'answer:grep' },
    ]);
    expect(appended(p, 1).at(-1)?.content).toBe(BUDGET_NOTE.replace('{remaining}', '9').replace('{max_tool_turns}', '10'));
    expect(appended(p, 2).at(-1)?.content).toContain('8 of 10');
    expect(tools.dispatched).toHaveLength(3);
  });

  test('intent, context, history, and layout go only in the first prompt', async () => {
    const { github, tools } = box({ 'src/a.py': 'source', 'README.md': 'readme' });
    const p = new FakeProvider([[fc()], [msg()]]);
    await run(p, { tools_exec: tools, github, context: 'Project context', already_raised: ['old open finding'],
      already_resolved: ['old resolved finding'], pr_intent: { title: 'Fix amounts', body: 'id-asc order intended' } });
    const first = JSON.stringify(p.calls[0].input);
    for (const text of ['Project context', 'old open finding', 'old resolved finding', 'id-asc order intended', 'README.md', 'src/']) expect(first).toContain(text);
    // Later turns replay the first prompt byte-for-byte — it is never rebuilt,
    // truncated, or duplicated into the transcript.
    expect((batch(p, 1)[0] as { content: string }).content).toBe((batch(p, 0)[0] as { content: string }).content);
    expect(JSON.stringify(p.calls[1].input).split('old resolved finding')).toHaveLength(2);
    expect(github.trees).toEqual(['deadbeef']);
  });

  test('TurnBudget admits the loop and every pending output precedes exactly one final', async () => {
    const p = new FakeProvider([[fc('grep', 'c1'), fc('read_file', 'c2')], [msg()]]);
    const r = await run(p, { max_tool_turns: 1 });
    expect(r.budget_exhausted).toBe(true); expect(r.turns).toBe(2); expect(r.tool_calls).toBe(2);
    expect(p.calls[1].tools).toBeNull();
    expect(toolOutputs(p, 1).map(x => x.call_id)).toEqual(['c1', 'c2']);
    expect(appended(p, 1).at(-2)?.content).toContain('0 of 1');
    expect(appended(p, 1).at(-1)).toEqual({ role: 'user', content: FORCED_FINAL_INPUT });
    // Appending on the final turn is what keeps the diff in the request.
    expect(JSON.stringify(batch(p, 1))).toContain('diff --git');
    expect(p.calls[1].deadline_s).toBe((p.calls[0].deadline_s as number) + FORCED_FINAL_GRACE_S);
    expect(p.calls[1].timeout_s).toBe(FORCED_FINAL_GRACE_S);
  });

  test('actual shared budget first-turn exception and irreversible final admission', () => {
    const b = new TurnBudget(2, 100);
    expect(b.take(9999)).toBe('regular');
    expect(b.take(9999)).toBe('final');
    expect(b.take(0)).toBe('stop');
  });

  test('wall exhaustion cannot skip the initial diff and first turn keeps full timeout', async () => {
    let now = 1000;
    const p = new FakeProvider([[fc()], [msg()]]);
    p.onCall = () => { now += 1; };
    const r = await run(p, { wall_timeout_s: 1e-9, clock: () => now });
    expect(p.calls[0].tools).toEqual(TOOLS); expect(p.calls[0].timeout_s).toBe(300);
    expect(JSON.stringify(p.calls[0].input)).toContain('diff --git');
    expect(r.budget_exhausted).toBe(true);
  });

  test('later timeout uses remaining wall time and final uses min(per turn, grace)', async () => {
    let now = 1000;
    const p = new FakeProvider([[fc()], [fc('grep')], [msg()]]);
    p.onCall = i => { now += i === 0 ? 200 : 100; };
    const r = await run(p, { wall_timeout_s: 250, per_turn_timeout_s: 300, clock: () => now });
    expect(p.calls.map(c => c.timeout_s)).toEqual([300, 50, 120]);
    expect(p.calls.map(c => c.deadline_s)).toEqual([1250, 1250, 1370]);
    expect(p.calls[0].clock).toBeDefined(); // provider retries share the injected epoch
    expect(r.budget_exhausted).toBe(true);
    const short = new FakeProvider([[fc()], [msg()]]);
    await run(short, { max_tool_turns: 1, per_turn_timeout_s: 3 });
    expect(short.calls[1].timeout_s).toBe(3);
  });

  test('first regular is admitted even when startup clock has already exceeded the wall', async () => {
    const readings = [1000, 2000, 2000];
    const p = new FakeProvider([[msg()]]);
    const result = await run(p, { wall_timeout_s: 1, clock: () => readings.shift() ?? 2000 });
    expect(result.turns).toBe(1); expect(p.calls[0].timeout_s).toBe(300);
  });

  test('invalid options reject before any provider or tool call', async () => {
    for (const bad of [0, -1, 1.1, NaN, Infinity]) {
      const p = new FakeProvider([[msg()]]);
      await expect(run(p, { max_tool_turns: bad })).rejects.toThrow();
      expect(p.calls).toHaveLength(0);
    }
    for (const field of ['wall_timeout_s', 'per_turn_timeout_s'] as const) {
      for (const bad of [0, -1, NaN, Infinity]) await expect(run(new FakeProvider([[msg()]]), { [field]: bad })).rejects.toThrow();
    }
  });

  test('normal and forced incomplete finals propagate; incomplete tool turns do not', async () => {
    for (const forced of [false, true]) {
      const p = new FakeProvider([...(forced ? [[fc()]] : []), { output: [msg()], status: 'incomplete' }]);
      const r = await run(p, { max_tool_turns: 1 });
      expect(r.final_truncated).toBe(true); expect(r.budget_exhausted).toBe(forced);
    }
    const p = new FakeProvider([{ output: [fc()], status: 'incomplete' }, [msg()]]);
    expect((await run(p)).final_truncated).toBe(false);
  });

  test('empty regular/final output fails visibly and never requests a second final', async () => {
    await expect(run(new FakeProvider([[{ type: 'reasoning' }]]))).rejects.toThrow('neither tool calls nor text');
    for (const output of [[], [fc()]]) {
      const p = new FakeProvider([[fc()], output]);
      await expect(run(p, { max_tool_turns: 1 })).rejects.toThrow('no final answer under budget');
      expect(p.calls).toHaveLength(2);
    }
  });

  test('missing call id falls back to the item id, and calls beat incidental text', async () => {
    const noCallId = { ...fc(), call_id: '' };
    const p = new FakeProvider([[noCallId, msg('not final')], { id: '', output: [fc()], status: 'completed' }, [msg()]]);
    const r = await run(p);
    expect(toolOutputs(p, 1)[0]?.call_id).toBe('item_c1');
    // An empty response id cannot truncate the transcript: later turns still
    // carry the diff and the earlier items.
    expect(JSON.stringify(p.calls[1].input)).toContain('diff --git');
    expect(JSON.stringify(p.calls[2].input)).toContain('item_c1');
    expect(r.turns).toBe(3);
  });

  test('unknown tools answer the turn without arbitrary execution; hostile names stay counters', async () => {
    const { tools } = box();
    const p = new FakeProvider([[fc('shell', 'a', '{"cmd":"rm -rf /"}'), fc('__proto__', 'b'), fc('__proto__', 'c')], [msg()]]);
    const r = await run(p, { tools_exec: tools });
    expect(toolOutputs(p, 1)[0].output).toContain('unknown tool');
    expect(r.tool_counts.shell).toBe(1);
    expect(Object.getOwnPropertyDescriptor(r.tool_counts, '__proto__')?.value).toBe(2);
  });

  test('default ToolBox honors injected github without a network call', async () => {
    const github = new FakeGitHub({ 'a.py': 'pinned source' });
    const p = new FakeProvider([[fc()], [msg()]]);
    await run(p, { tools_exec: undefined, github });
    expect(github.reads).toEqual([['deadbeef', 'a.py']]);
    expect(toolOutputs(p, 1)[0].output).toBe('pinned source');
  });
});

describe('read-only ToolBox', () => {
  test('tool registrations are flat strict schemas and teach bounded recovery', () => {
    expect(TOOLS.map(t => t.name)).toEqual(['read_file', 'file_history', 'list_dir', 'grep']);
    expect(TOOLS.every(t => t.type === 'function' && t.strict && !t.parameters.additionalProperties)).toBe(true);
    expect(AGENT_ADDENDUM).toContain('narrow the path');
  });

  test('disabled tools name the actual missing token or sha and do no I/O', async () => {
    for (const [sha, token, expected] of [['local', 'tok', '--head-sha'], ['', 'tok', '--head-sha'], ['sha', '', 'no GitHub token']]) {
      const github = new FakeGitHub();
      const tools = new ToolBox('o/r', sha, token, '', github);
      for (const name of TOOLS.map(t => t.name)) expect(await tools.dispatch(name, '{}')).toContain(expected);
      expect(await tools.repo_map()).toBe('');
      expect(github.trees).toHaveLength(0); expect(github.reads).toHaveLength(0);
    }
  });

  test('paths are validated before API access: traversal, absolute, drive, backslash, encoding, and symlink-like escape', async () => {
    const { github, tools } = box();
    for (const path of ['../secret', 'link/../secret', 'link/../../etc/passwd', '/etc/passwd', '//host/share', 'C:/secret', 'C:\\secret', 'file:///etc/passwd', 'a\\..\\secret', 'a/./b', 'a//b', '%2e%2e/secret', '%252e%252e/secret', '%2fetc/passwd', 'a/%00x', 'bad\u0000name']) {
      for (const name of ['read_file', 'file_history', 'list_dir', 'grep']) {
        expect(await tools.dispatch(name, JSON.stringify({ path, pattern: 'x' }))).toStartWith('error:');
      }
    }
    expect(github.reads).toHaveLength(0); expect(github.trees).toHaveLength(0);
    expect(github.dirs).toHaveLength(0); expect(github.histories).toHaveLength(0);
  });

  test('valid unicode, spaces, quotes, and literal percent paths are passed as data at the pinned sha', async () => {
    const path = 'src/日本語/50% "file".ts';
    const { tools, github } = box({ [path]: 'ok' });
    expect(await tools.read_file(path)).toBe('ok');
    expect(github.reads).toEqual([['deadbeef', path]]);
  });

  test('offset validation, slicing, and splitlines semantics', async () => {
    const { tools } = box({ 'a.py': 'a\r\nb\rc\u2028d\n', empty: '' });
    expect(await tools.read_file('a.py', 2)).toBe('b\nc\nd');
    expect(await tools.read_file('empty')).toBe('');
    expect(await tools.read_file('a.py', 99)).toContain('has 4 line(s)');
    for (const offset of [0, -1, 1.5, true, '2', Infinity]) expect(await tools.read_file('a.py', offset)).toContain('positive 1-based');
    for (const path of ['', null, 4]) expect(await tools.read_file(path)).toContain('non-empty string');
  });

  test('read truncation on newline gives exact recoverable next offset', async () => {
    const { tools, github } = box({ 'a.py': 'l\n'.repeat(READ_MAX_CHARS / 2) + 'next\nlast\n' });
    const first = await tools.read_file('a.py');
    expect(first.slice(0, READ_MAX_CHARS)).toBe('l\n'.repeat(READ_MAX_CHARS / 2));
    const next = Number(first.match(/offset=(\d+)/)?.[1]);
    expect(next).toBe(READ_MAX_CHARS / 2 + 1);
    expect(await tools.read_file('a.py', next)).toBe('next\nlast');
    expect(github.reads).toHaveLength(1);
  });

  test('mid-line truncation discloses skipped text; final long line never promises an impossible offset', async () => {
    const { tools } = box({ 'a.py': 'x'.repeat(READ_MAX_CHARS + 1) + '\nlast', 'b.py': 'x'.repeat(READ_MAX_CHARS + 1) });
    const mid = await tools.read_file('a.py');
    expect(mid).toContain('inside line 1'); expect(mid).toContain('is skipped'); expect(mid).toContain('offset=2');
    expect(await tools.read_file('a.py', 2)).toBe('last');
    const last = await tools.read_file('b.py');
    expect(last).toContain('cannot be read with offsets'); expect(last).not.toContain('offset=');
  });

  test('read limits count Unicode code points, not UTF-16 units', async () => {
    const { tools } = box({ 'a.py': '😀'.repeat(READ_MAX_CHARS) });
    const out = await tools.read_file('a.py');
    expect(out).not.toContain('truncated'); expect(Array.from(out)).toHaveLength(READ_MAX_CHARS);
  });

  test('file cache is bounded, cached files remain usable and missing files stay retryable', async () => {
    const size = 500_000;
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${i}.py`, 'x'.repeat(size)]));
    const { tools, github } = box(files);
    for (let i = 0; i < FILE_CACHE_MAX_BYTES / size; i++) expect(await tools.read_file(`${i}.py`)).not.toStartWith('error:');
    expect(await tools.read_file('8.py')).toContain('cache is full');
    expect(await tools.read_file('0.py')).not.toStartWith('error:');
    expect(github.reads).toHaveLength(8);
    const missing = box();
    expect(await missing.tools.read_file('new')).toContain('not found');
    missing.github.files.new = 'now present';
    expect(await missing.tools.read_file('new')).toBe('now present');
  });

  test('oversize files are not cached and refetches have a separate finite budget', async () => {
    const size = CACHEABLE_FILE_BYTES + 1;
    const { tools, github } = box({ 'a.py': 'x'.repeat(size), small: 'fine' });
    const allowed = Math.floor(OVERSIZE_FETCH_MAX_BYTES / size);
    for (let i = 0; i < allowed; i++) expect(await tools.read_file('a.py')).not.toStartWith('error:');
    expect(await tools.read_file('a.py')).toContain('cache is full');
    expect(await tools.read_file('a.py')).toContain('cache is full');
    expect(github.reads.filter(([, path]) => path === 'a.py')).toHaveLength(allowed + 1);
  });

  test('file history formats bounded commit headers and pins path/ref/limit', async () => {
    const { tools, github } = box();
    const path = 'ml/SWE-Bench Verified/predictions.jsonl';
    github.history = [{ sha: 'b'.repeat(40), date: '2026-10-15T10:00:00Z', message: 'second\nbody' },
      { sha: 'a'.repeat(40), date: '2026-10-01T10:00:00Z', message: 'first' }];
    expect(await tools.file_history(path)).toBe('bbbbbbbbbb 2026-10-15 second\naaaaaaaaaa 2026-10-01 first');
    expect(github.histories).toEqual([[path, 'deadbeef', FILE_HISTORY_MAX]]);
    github.history = [];
    expect(await tools.file_history(path)).toContain('no commits found');
    github.history = Array.from({ length: 20 }, () => ({ sha: 'abc', date: '', message: 'x'.repeat(200) }));
    expect((await tools.file_history(path)).split('\n')).toHaveLength(FILE_HISTORY_MAX);
  });

  test('directory listings preserve file/dir formatting and entry bounds', async () => {
    const { tools, github } = box();
    github.listings.set('', [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }]);
    expect(await tools.list_dir()).toBe('src/\nREADME.md');
    github.listings.set('empty', []); expect(await tools.list_dir('empty')).toBe('(directory is empty)');
    expect(await tools.list_dir('missing')).toContain('not found');
    github.listings.set('big', Array.from({ length: LIST_MAX_ENTRIES + 1 }, (_, i) => ({ name: `${i}`, type: 'file' })));
    expect((await tools.list_dir('big')).split('\n')).toHaveLength(LIST_MAX_ENTRIES + 1);
    expect(await tools.list_dir('big')).toContain(`[truncated at ${LIST_MAX_ENTRIES} entries]`);
  });

  test('dispatch rejects malformed arguments and errors do not poison retries', async () => {
    const { tools, github } = box({ 'a.py': 'fixed' });
    expect(await tools.dispatch('read_file', '{path: x}')).toContain('not valid JSON');
    for (const value of ['[]', 'null', '42', '"a"']) expect(await tools.dispatch('read_file', value)).toContain('JSON object');
    expect(await tools.dispatch('exec', '{}')).toContain('unknown tool');
    github.failFile = 'a.py';
    expect(await tools.dispatch('read_file', '{"path":"a.py"}')).toContain('GitHub API failure');
    github.failFile = undefined;
    expect(await tools.dispatch('read_file', '{"path":"a.py"}')).toBe('fixed');
  });

  test('exact duplicate calls use canonical argument keys; offset calls remain distinct', async () => {
    const { tools, github } = box({ 'a.py': 'a\nb\nc' });
    expect(await tools.dispatch('read_file', '{"path":"a.py","offset":2}')).toBe('b\nc');
    expect(await tools.dispatch('read_file', '{"offset":2,"path":"a.py"}')).toContain('already answered');
    expect(await tools.dispatch('read_file', '{"path":"a.py","offset":3}')).toBe('c');
    expect(github.reads).toHaveLength(1);
  });

  test('concurrent dispatch remains ordered and suppresses identical complete calls', async () => {
    const { tools, github } = box({ 'a.py': 'answer' });
    const out = await Promise.all([tools.dispatch('read_file', '{"path":"a.py"}'), tools.dispatch('read_file', '{"path":"a.py"}')]);
    expect(out[0]).toBe('answer'); expect(out[1]).toContain('already answered');
    expect(github.reads).toHaveLength(1);
  });
});

describe('bounded grep and repository map', () => {
  test('default scope is diff paths; missing paths are disclosed without widening', async () => {
    const { tools, github } = box({ 'a.py': 'one\ntwo bug here\nthree\n', other: 'bug' }, ['a.py', 'deleted']);
    const out = await tools.grep('bug');
    expect(out).toContain('a.py:2: two bug here'); expect(out).toContain('1 unreadable');
    expect(out).toContain('searched 1 file(s)'); expect(out).not.toContain('other:');
    expect(github.trees).toHaveLength(0);
    expect(await tools.grep('absent')).toContain('no matches');
  });

  test('recursive subtree and explicit file share one cached tree; map is two levels', async () => {
    const { tools, github } = box({ 'src/a.py': 'bug', 'src/deep/z.py': 'bug', 'src2/other': 'bug', 'README.md': '' });
    const out = await tools.grep('bug', 'src');
    expect(out).toContain('directory src (recursive)'); expect(out).toContain('src/deep/z.py:1: bug'); expect(out).not.toContain('src2/other:');
    const one = await tools.grep('bug', 'src/a.py');
    expect(one).toContain('file src/a.py'); expect(one).not.toContain('deep/z');
    const layout = await tools.repo_map();
    expect(layout).toContain('README.md'); expect(layout).toContain('src/\n  a.py\n  deep');
    expect(layout).not.toContain('z.py'); expect(github.trees).toEqual(['deadbeef']);
  });

  test('tree truncation and file cap are disclosed before any extra reads', async () => {
    const files = Object.fromEntries(Array.from({ length: GREP_MAX_FILES + 5 }, (_, i) => [`src/f${i}.py`, 'absent']));
    const { tools, github } = box(files);
    github.tree[1] = true;
    const out = await tools.grep('needle', 'src');
    expect(out).toContain('GitHub truncated the tree listing'); expect(out).toContain(`truncated at ${GREP_MAX_FILES} files`);
    expect(github.reads).toHaveLength(GREP_MAX_FILES);
    const second = box(files);
    const diffOut = await second.tools.grep('needle');
    expect(diffOut).toContain(`the diff's changed files (truncated at ${GREP_MAX_FILES} files)`);
  }, 20_000);

  test('tree API failures fall back to bounded direct files, disclose listing cap, and preserve file search', async () => {
    const { tools, github } = box({ 'src/a.py': 'needle', 'src/deep.py': 'needle' });
    github.failTree = true;
    github.listings.set('src', [{ name: 'a.py', type: 'file' }, { name: 'deep', type: 'dir' }]);
    expect(await tools.grep('needle', 'src')).toContain('direct files — recursive tree unavailable');
    expect(await tools.grep('needle', 'src/a.py')).toContain('src/a.py:1: needle');
    github.listings.set('big', Array.from({ length: LISTING_CAP }, (_, i) => ({ name: `f${i}`, type: i === 0 ? 'file' : 'dir' })));
    expect(await tools.grep('needle', 'big')).toContain(`may be truncated at GitHub's ${LISTING_CAP}-entry cap`);
    github.failListing = true;
    expect(await tools.grep('needle', 'src')).toStartWith('error: GitHub API failure scoping grep');
    expect(await tools.repo_map()).toBe('');
  });

  test('map is bounded per line and tree incompleteness stays visible', async () => {
    const { tools, github } = box();
    github.tree = [Array.from({ length: 200 }, (_, i) => `dir/file${i}.py`), true];
    const layout = await tools.repo_map(100);
    expect(layout).toContain('layout truncated'); expect(layout).toContain('some paths missing');
    expect(layout.length).toBeLessThan(220);
  });

  test('regex guard rejects nested quantifiers but permits safe groups, escapes, and classes', async () => {
    for (const pattern of ['(a+)+$', '(a*)*b', '(?:a+)+', '(?P<x>a*)*b', '(?i:a+)+', '((a+))+']) expect(_risky_pattern(pattern)).toBe(true);
    for (const pattern of ['(a+)', '(a+)(b+)', '(?:foo|bar)+', '(?<=ab)c+', '(?P<name>a|b)+', '(?i)CASE', '\\* pointer', '[()+*]']) expect(_risky_pattern(pattern)).toBe(false);
    const { tools, github } = box({ 'a.py': 'foobar\nCASE\n' });
    expect(await tools.grep('(a+)+')).toContain('pattern rejected'); expect(github.reads).toHaveLength(0);
    expect(await tools.grep('*broken(')).toContain('invalid regular expression');
    expect(await tools.grep('(?:foo|bar)+')).toContain('foobar');
    expect(await tools.grep('(?i)case')).toContain('CASE');
    expect(await tools.grep('(?P<name>foo)bar')).toContain('foobar');
  });

  test('pattern and context validation rejects coercion without making requests', async () => {
    const { tools, github } = box();
    for (const pattern of ['', null, 2]) expect(await tools.grep(pattern)).toContain('non-empty string pattern');
    for (const context of [true, -1, 4, '2', 1.2, NaN]) expect(await tools.grep('x', '', context)).toContain('between 0 and 3');
    expect(github.reads).toHaveLength(0);
  });

  test('grep searches past column 400 but visibly clips only the display', async () => {
    const { tools } = box({ 'a.py': 'x'.repeat(500) + ' needle\n' });
    const out = await tools.grep('needle');
    expect(out).toContain('a.py:1:'); expect(out).toContain('line truncated for display'); expect(out).not.toContain('needle');
  });

  test('context echoes surrounding lines, deduplicates overlaps, and does not count as matches', async () => {
    const { tools } = box({ 'a.py': 'line1\nline2\nline3 bug\nline4 bug\nline5\nline6\nline7' });
    const out = await tools.grep('bug', '', 2);
    expect(out).toContain('  a.py:1: line1'); expect(out).toContain('a.py:3: line3 bug');
    expect(out).toContain('a.py:4: line4 bug'); expect(out).toContain('  a.py:6: line6');
    expect(out).not.toContain('a.py:7:');
    expect(out.match(/a.py:2:/g)).toHaveLength(1);
  });

  test('match cap freezes final trailing context even in dense files; incomplete result remains retryable', async () => {
    const { tools, github } = box({ 'a.py': Array.from({ length: 500 }, (_, i) => `line${i + 1} bug`).join('\n'), 'b.py': 'bug' });
    const args = JSON.stringify({ pattern: 'bug', context_lines: 3 });
    const out = await tools.dispatch('grep', args);
    expect(out.split('\n').filter(l => l.startsWith('a.py:'))).toHaveLength(GREP_MAX_MATCHES);
    expect(out).toContain(`  a.py:${GREP_MAX_MATCHES + 3}:`);
    expect(out).not.toContain(`a.py:${GREP_MAX_MATCHES + 4}:`); expect(out).not.toContain('b.py:');
    expect(out).toContain(`match cap reached at ${GREP_MAX_MATCHES}`);
    expect(await tools.dispatch('grep', args)).not.toContain('already answered');
    expect(github.reads).toHaveLength(1);
  });

  test('cap reached at EOF stays capped instead of caching a partial result as complete', async () => {
    const { tools } = box({ 'a.py': 'bug\n'.repeat(GREP_MAX_MATCHES), 'b.py': 'bug' });
    const args = '{"pattern":"bug","context_lines":3}';
    expect(await tools.dispatch('grep', args)).toContain('match cap reached');
    expect(await tools.dispatch('grep', args)).toContain('match cap reached');
  });

  test('oversized files skip individually, bytes aggregate once, later small files still match', async () => {
    const { tools } = box({ 'a.py': 'x'.repeat(GREP_MAX_BYTES + 1), 'b.py': 'y'.repeat(GREP_MAX_BYTES + 1), 'c.py': 'needle' });
    const out = await tools.grep('needle');
    expect(out).toContain('searched 1 file(s)'); expect(out).toContain('c.py:1: needle');
    expect(out.match(/skipped — byte cap/g)).toHaveLength(1);
    expect(out).toContain('2 file(s) fetched but skipped');
  });

  test('cache exhaustion keeps earlier matches and does not claim later files are missing', async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'x'.repeat(500_000)]));
    const { tools } = box(files, ['f9']);
    for (let i = 0; i < 8; i++) await tools.read_file(`f${i}`);
    const out = await tools.grep('needle');
    expect(out).toContain('file cache full'); expect(out).toContain('no files were searched'); expect(out).not.toContain('unreadable');
  });

  test('fetch failure before scanning is not no-matches, later failure retains discovered matches, retries run again', async () => {
    const { tools, github } = box({ 'a.py': 'needle', 'b.py': 'needle' });
    github.failFile = 'a.py';
    const none = await tools.grep('needle');
    expect(none).toContain('no files were searched'); expect(none).not.toContain('no matches');
    github.failFile = 'b.py';
    const partial = await tools.dispatch('grep', '{"pattern":"needle"}');
    expect(partial).toContain('a.py:1: needle'); expect(partial).toContain('GitHub API failure reading b.py');
    github.failFile = undefined;
    const complete = await tools.dispatch('grep', '{"pattern":"needle"}');
    expect(complete).toContain('b.py:1: needle');
    expect(await tools.dispatch('grep', '{"pattern":"needle"}')).toContain('already answered');
  });

  test('killable scan preserves streamed matches before a runaway regex, then continues to next file', async () => {
    class ShortScanBox extends ToolBox {
      protected override scan_file(rx: RegExp, text: string, path: string, start: number, seconds: number, context: number) {
        return _timed_scan(rx, text, path, start, Math.min(seconds, 0.25), context);
      }
    }
    const github = new FakeGitHub({ 'a.py': 'the needle line\n' + 'a'.repeat(44) + 'b', 'b.py': 'the needle' });
    const tools = new ShortScanBox('o/r', 'deadbeef', 'tok', diffFor('a.py', 'b.py'), github);
    const out = await tools.grep('needle|(a|a)+$');
    expect(out).toContain('a.py:1: the needle line'); expect(out).toContain('a.py scan incomplete — per-file time cap');
    expect(out).toContain('b.py:1: the needle'); expect(out).toContain('searched 2 file(s)'); expect(out).toContain('1 scan(s) incomplete');
    expect(await tools.dispatch('grep', '{"pattern":"needle|(a|a)+$"}')).not.toContain('already answered');
  });

  test('worker error or exit without a done record is an incomplete scan, not a clean result', async () => {
    // Deliberately malformed worker input exercises the error/exit receipt.
    const broken = { source: '(', flags: '' } as RegExp;
    const result = await _timed_scan(broken, 'needle', 'a.py', 0, 1);
    expect(result.timed_out).toBe(true); expect(result.lines_searched).toBe(0);
    expect(result.matches).toEqual([]); expect(result.capped).toBe(false);
  });

  test('a regex timeout before any completed line is not counted as searched', async () => {
    const result = await _timed_scan(/(a|a)+$/, 'a'.repeat(44) + 'b', 'a.py', 0, 0.2);
    expect(result).toEqual({ matches: [], match_count: 0, lines_searched: 0, timed_out: true, capped: false });
  });

  test('deterministic incomplete scan does not poison duplicates or claim a clean verdict', async () => {
    class IncompleteBox extends ToolBox {
      scans = 0;
      protected override async scan_file(): Promise<ScanResult> {
        this.scans++;
        return { matches: [], match_count: 0, lines_searched: 0, timed_out: true, capped: false };
      }
    }
    const github = new FakeGitHub({ 'a.py': 'needle' });
    const tools = new IncompleteBox('o/r', 'deadbeef', 'tok', diffFor('a.py'), github);
    expect(await tools.dispatch('grep', '{"pattern":"needle"}')).toContain('no files were searched');
    expect(await tools.dispatch('grep', '{"pattern":"needle"}')).not.toContain('already answered');
    expect(tools.scans).toBe(2);
  });
});
