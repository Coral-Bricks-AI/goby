import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import * as contract from './contract.ts';
import * as diffs from './diff.ts';
import {run_agent_review} from './agent.ts';
import {ReviewLifecycle} from './rules.ts';
import {assertHead, HeadChanged, loadReceipt, refreshGate} from './gate.ts';
import {diffDigest, receiptMarker, type GateResult, type ReviewReceipt} from './verdict.ts';
import {GitHubClient} from '../platforms/github.ts';
import {post_review, post_status, post_gate_status, reply_in_thread, resolve_thread} from '../platforms/publish.ts';
import {call_model, type ModelReply} from '../providers/base.ts';
import {resolve_provider} from '../providers/index.ts';
import {REVIEW_VERSION, STATUS_CONTEXT} from '../identity.ts';

type Thread = Parameters<typeof contract.split_already_raised>[1][number];
type AgentReply = Awaited<ReturnType<typeof run_agent_review>>;
export interface ReviewOptions {
  pr?: number; repo?: string; token?: string; diff_file?: string; head_sha?: string; pr_hint?: number;
  expected_head?: string; dry_run?: boolean; agent?: boolean; force?: boolean; fail_on_blocked?: boolean;
  provider?: string; model?: string; base_url?: string; api_key?: string; api_key_file?: string;
  max_tool_turns?: number; agent_wall_timeout?: number; max_diff_lines?: number; max_findings?: number;
  timeout?: number; cwd?: string;
}
export interface ReviewDependencies {
  github?: GitHubClient;
  model?: typeof call_model;
  agent?: typeof run_agent_review;
  warn?: (message: string) => void;
}
export interface ReviewOutcome {exitCode: number; report: Record<string, unknown>; summary?: string; gate?: GateResult}

export function repoFromRemote(cwd = process.cwd()): string {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote)?.slice(1).join('/') ?? '';
  } catch { return ''; }
}
export async function readKeyFile(path: string): Promise<string> {
  const content = await readFile(path.replace(/^~(?=\/)/, homedir()), 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }
  throw new Error(`No API_KEY= line in ${path}`);
}
function isAgent(reply: ModelReply | AgentReply): reply is AgentReply { return 'turns' in reply; }
export function build_summary(model: string, reply: ModelReply | AgentReply, inline: contract.Finding[], overflow: contract.Finding[], droppedPaths: number, droppedCap: number,
  dupes: contract.Finding[] = [], agent = false, retracted = 0, resolved: contract.Finding[] = []): string {
  const count = inline.length + overflow.length;
  const lines = [`**Goby Review** — ${agent ? 'agentic' : 'one-turn'} review (v${REVIEW_VERSION}) via \`${model}\` ` +
    (agent ? '(agentic: it read the code around this diff before reporting).' : '(one-turn: diff only, no code reading — findings are less certain).'), ''];
  if (!count && !dupes.length && !resolved.length) lines.push('No bugs found in this diff.');
  else if (!count) lines.push('No NEW bugs in this diff. Withheld finding(s):');
  else lines.push(`Found **${count}** bug(s): ${inline.length} inline below, ${overflow.length} outside the diff hunks.`);
  for (const finding of overflow) lines.push(`- \`${finding.path}:${finding.line}\` **[${finding.severity}]** ${finding.title} — ${finding.detail.slice(0, 300)}`);
  if (droppedPaths) lines.push(`- (${droppedPaths} finding(s) on ignored paths were dropped.)`);
  if (retracted) lines.push(`- (${retracted} self-retracted finding(s) were dropped.)`);
  if (droppedCap) lines.push(`- (${droppedCap} further finding(s) beyond the --max-findings cap were not reported.)`);
  for (const [label, findings] of [['already-open', dupes], ['resolved re-derivation', resolved]] as const) {
    if (findings.length) lines.push('', `${findings.length} ${label} finding(s) withheld:`, ...findings.map(f => `- \`${f.path}:${f.line}\` **[${f.severity}]** ${f.title}`));
  }
  lines.push('', `Model call: ${reply.elapsed_s.toFixed(1)}s, ${reply.prompt_tokens}+${reply.completion_tokens} tokens.`);
  if (isAgent(reply)) lines.push('', `Agentic loop: ${reply.turns} model turn(s), ${reply.tool_calls} tool call(s)` +
    (reply.budget_exhausted ? ' — budget exhausted, review cut short' : '') +
    (reply.final_truncated ? ' — final answer truncated by the model\'s output-token limit, findings may be incomplete' : '') + '.');
  return lines.join('\n');
}
async function cleanup(client: GitHubClient, pr: number, threads: Thread[], warn: (s: string) => void): Promise<void> {
  for (const [thread, note] of contract.plan_thread_resolution(threads)) {
    try {
      await resolve_thread(client, String(thread.thread_id));
      try { await reply_in_thread(client, pr, Number(thread.comment_id), note); } catch (e) { warn(`Resolution reply failed: ${e}`); }
    } catch (e) { warn(`Thread cleanup failed: ${e}`); }
  }
  try {
    const [summaries, allSummaries] = await client.fetch_own_summaries(pr);
    const [opened, resolved, allThreads] = await client.fetch_thread_state(pr);
    if (!allSummaries || !allThreads) return;
    const openHeads = new Set(opened.map(t => t.sha));
    const resolvedHeads = new Set(resolved.map(t => t.sha));
    for (const s of summaries) {
      if (s.sha && !s.minimized && !s.agent && resolvedHeads.has(s.sha) && !openHeads.has(s.sha)) await client.minimize_comment(s.node_id);
    }
  } catch (e) { warn(`Summary cleanup skipped: ${e}`); }
}
async function localContext(cwd: string): Promise<string> {
  const parts = await Promise.all(['CLAUDE.md', 'AGENTS.md'].map(async file => {
    try { return `### ${file}\n\n${(await readFile(join(cwd, file), 'utf8')).slice(0, 20_000)}`; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
  }));
  return parts.filter(Boolean).join('\n\n');
}
function lineCount(text: string): number { return text ? text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) : 0; }

export async function review(options: ReviewOptions, deps: ReviewDependencies = {}): Promise<ReviewOutcome> {
  const o = {max_tool_turns: 10, agent_wall_timeout: 600, max_diff_lines: 10000, max_findings: 30, timeout: 300, cwd: process.cwd(), ...options};
  if ((!o.pr && !o.diff_file) || (o.pr && o.diff_file)) throw new Error('Choose exactly one of --pr or --diff-file');
  if (o.diff_file && (!o.dry_run || o.expected_head)) throw new Error('--diff-file requires --dry-run and cannot use --expected-head');
  if ((o.head_sha || o.pr_hint) && !o.diff_file) throw new Error('--head-sha and --pr-hint require --diff-file');
  if (!Number.isSafeInteger(o.max_tool_turns) || o.max_tool_turns < 1 || !Number.isFinite(o.agent_wall_timeout) || o.agent_wall_timeout <= 0) throw new Error('Invalid agent budget');
  if (!Number.isSafeInteger(o.max_diff_lines) || o.max_diff_lines < 1 || !Number.isSafeInteger(o.max_findings) || o.max_findings < 0) throw new Error('Invalid review cap');
  const provider = resolve_provider(o.provider);
  const model = o.model ?? provider.default_model;
  if (!model) throw new Error('Specify --model for this provider');
  const repo = o.repo || repoFromRemote(o.cwd);
  if (o.pr && (!repo || !o.token)) throw new Error('Live review requires repository and GitHub token');
  const client = deps.github ?? new GitHubClient(repo, o.token ?? '');
  const warn = deps.warn ?? (message => console.error(message));
  const lifecycle = new ReviewLifecycle();
  let head = o.head_sha ?? 'local';
  let baseRef = '';
  let opened: Thread[] = [], history: (Thread & {resolution?: string})[] = [];
  try {
    let diff: string, context: string;
    let intent: {title?: string; body?: string} | null = null;
    if (o.diff_file) {
      diff = await readFile(o.diff_file, 'utf8');
      context = o.head_sha && o.token ? await client.fetch_repo_context(head) : await localContext(o.cwd);
      if (o.pr_hint && o.token) { try { intent = await client.fetch_pr_intent(o.pr_hint); } catch (e) { warn(`PR intent unavailable: ${e}`); } }
    } else {
      let stable = false; diff = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await client.fetch_pr_meta(o.pr!);
        head = before.head_sha; baseRef = before.base_ref;
        diff = await client.fetch_diff(o.pr!);
        const after = await client.fetch_pr_meta(o.pr!);
        if (after.head_sha === head && after.base_ref === baseRef) { stable = true; break; }
      }
      if (!stable || o.expected_head && head !== o.expected_head) throw new HeadChanged('PR head moved; review superseded');
      if (!o.dry_run) {
        await post_gate_status(client, head, 'pending', 'Review in progress');
        await post_status(client, head, 'pending', 'Review in progress');
      }
      context = await client.fetch_repo_context(head);
      try { intent = await client.fetch_pr_intent(o.pr!); } catch (e) { warn(`PR intent unavailable: ${e}`); }
    }
    lifecycle.transition('fetched');
    if (o.pr && !o.dry_run && !o.force) {
      const previous = await loadReceipt(client, o.pr, head);
      if (previous?.complete && previous.base_ref === baseRef && previous.diff_sha256 === diffDigest(diff) && (!o.agent || previous.agent)) {
        opened = await client.fetch_open_own_threads(o.pr);
        await cleanup(client, o.pr, opened, warn);
        await assertHead(client, o.pr, head);
        lifecycle.transition('reused');
        await post_status(client, head, 'success', 'Complete review reused on unchanged head');
        const gate = await refreshGate(client, o.pr, {expected_head: head});
        return {exitCode: o.fail_on_blocked && gate.state !== 'success' ? 2 : 0, report: {pr: o.pr, head, skipped: 'head already reviewed', phase: lifecycle.phase}, gate};
      }
    }
    if (o.pr) {
      try { opened = await client.fetch_open_own_threads(o.pr); } catch (e) { warn(`Open-thread dedupe unavailable: ${e}`); }
      try { history = await client.fetch_resolved_own_threads(o.pr); } catch (e) { warn(`Resolved history unavailable: ${e}`); }
    }
    const diffLines = lineCount(diff);
    if (diffLines > o.max_diff_lines) {
      lifecycle.transition('skipped');
      const description = `Skipped: diff is ${diffLines} lines (cap ${o.max_diff_lines}).`;
      if (!o.dry_run && o.pr) {
        await assertHead(client, o.pr, head);
        await post_status(client, head, 'success', description);
        await post_gate_status(client, head, 'failure', description);
        await cleanup(client, o.pr, opened, warn);
      }
      return {exitCode: o.fail_on_blocked && !o.dry_run ? 2 : 0, report: {pr: o.pr, head, skipped: description, phase: lifecycle.phase}};
    }
    const key = o.api_key || process.env.GOBY_API_KEY || process.env[provider.api_key_env] || await readKeyFile(o.api_key_file ?? '~/.config/goby/api_key');
    history.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const raised = opened.filter(t => !t.outdated).map(t => `- \`${contract.format_thread_position(t)}\` — ${t.title}`);
    const resolvedPrompt = history.slice(0, 40).map(t => `- \`${contract.format_thread_position(t)}\` — ${t.title}${t.resolution ? ` (resolved: ${t.resolution})` : ''}`);
    if (history.length > 40) resolvedPrompt.push(`- (${history.length - 40} older resolved thread(s) omitted — the list above is the most recent history, not all of it.)`);
    const session = `review-pr${o.pr ?? 'local'}-${head.slice(0, 10)}`;
    const shared = {api_key: key, model, base_url: o.base_url ?? provider.base_url, session_id: session};
    lifecycle.transition('started');
    const reply: ModelReply | AgentReply = o.agent
      ? await (deps.agent ?? run_agent_review)({...shared, repo, head_sha: head, token: o.token ?? null, github: client, diff, context,
        already_raised: raised, already_resolved: resolvedPrompt, pr_intent: intent, max_tool_turns: o.max_tool_turns,
        wall_timeout_s: o.agent_wall_timeout, per_turn_timeout_s: o.timeout})
      : await (deps.model ?? call_model)({...shared, system: contract.SYSTEM_PROMPT,
        user: contract.build_user_prompt(diff, context, raised, resolvedPrompt, intent), timeout_s: o.timeout});
    const parsed = contract.parse_findings(reply.content, true);
    if (parsed === null) throw new Error('Could not parse model output (truncated or off-contract reply)');
    const [findings, retracted] = contract.drop_self_retracted(parsed);
    const hunks = diffs.parse_hunks(diff);
    const ambiguous: contract.Finding[] = [], unambiguous: contract.Finding[] = [];
    let ambiguousDropped = 0;
    for (const f of findings) {
      const [path, collision] = diffs.resolve_diff_path(f.path, hunks);
      if (collision) {
        if (contract.keep_path(f.path) && (!/^[ab]\//.test(f.path) || contract.keep_path(f.path.slice(2)))) ambiguous.push(f);
        else ambiguousDropped++;
      } else { f.path = path; unambiguous.push(f); }
    }
    const deduped = contract.dedupe_findings(unambiguous);
    const kept = deduped.filter(f => contract.keep_path(f.path));
    const droppedPaths = deduped.length - kept.length + ambiguousDropped;
    for (const f of kept) if (f.end_line !== null && f.end_line !== undefined) {
      const end = diffs.clamp_end_to_hunk(hunks, f.path, f.line, f.end_line);
      if (end !== null) f.end_line = end;
    }
    const [fresh, withheld] = contract.split_already_raised(kept, opened);
    const [notResolved, withheldResolved] = contract.split_resolved_rederivations(fresh, history);
    const ordered = [...notResolved, ...ambiguous].sort((a, b) => findings.indexOf(a) - findings.indexOf(b));
    const [selected, overCap] = contract.select_findings(ordered, o.max_findings);
    const inline: contract.Finding[] = [], overflow: contract.Finding[] = [];
    for (const f of selected) (ambiguous.includes(f) || !diffs.line_in_hunks(hunks, f.path, f.line) ? overflow : inline).push(f);
    const complete = !isAgent(reply) || !reply.budget_exhausted && !reply.final_truncated;
    const receipt: ReviewReceipt = {schema: 2, head_sha: head, base_ref: baseRef, diff_sha256: diffDigest(diff), complete, agent: !!o.agent, unthreaded: overflow.length + overCap, finding_ids: inline.map(f => f.fid)};
    const summary = build_summary(model, reply, inline, overflow, droppedPaths, overCap, withheld, !!o.agent, retracted.length, withheldResolved) + '\n\n' + receiptMarker(receipt);
    const report = {pr: o.pr ?? null, head, model, session_id: session, pr_intent_title: intent?.title || null, diff_lines: diffLines,
      inline: inline.length, overflow: overflow.length, dropped_paths: droppedPaths, dropped_cap: overCap, dropped_dupes: withheld.length,
      dropped_resolved: withheldResolved.length, dropped_retracted: retracted.length, ambiguous: ambiguous.length,
      findings: [...inline, ...overflow].map(f => ({path: f.path, line: f.line, ...(f.end_line == null ? {} : {end_line: f.end_line}), severity: f.severity, title: f.title, detail: f.detail.slice(0, 300)})),
      open_bot_threads: opened.length, resolved_history_threads: history.length, elapsed_s: reply.elapsed_s, tokens: [reply.prompt_tokens, reply.completion_tokens],
      dry_run: !!o.dry_run, review_complete: complete, ...(isAgent(reply) ? {agent: {turns: reply.turns, tool_calls: reply.tool_calls, tool_counts: reply.tool_counts,
        budget_exhausted: reply.budget_exhausted, final_truncated: reply.final_truncated, max_tool_turns: o.max_tool_turns, wall_timeout_s: o.agent_wall_timeout}} : {})};
    if (o.dry_run) { lifecycle.transition(complete ? 'complete' : 'incomplete'); return {exitCode: 0, report, summary}; }
    await assertHead(client, o.pr!, head);
    await post_review(client, o.pr!, head, summary, inline);
    lifecycle.transition(complete ? 'complete' : 'incomplete');
    let description = inline.length + overflow.length ? `${inline.length + overflow.length} new bug(s) found` : withheld.length || withheldResolved.length ? 'no new bugs; existing findings withheld' : 'no bugs found';
    if (isAgent(reply) && reply.budget_exhausted) description += '; budget exhausted';
    if (isAgent(reply) && reply.final_truncated) description += '; answer truncated';
    await post_status(client, head, 'success', description);
    await cleanup(client, o.pr!, opened, warn);
    const gate = await refreshGate(client, o.pr!, {expected_head: head});
    return {exitCode: o.fail_on_blocked && gate.state !== 'success' ? 2 : 0, report, summary, gate};
  } catch (error) {
    const superseded = error instanceof HeadChanged;
    if (['idle', 'ready', 'running'].includes(lifecycle.phase)) lifecycle.transition(superseded ? 'superseded' : 'error');
    if (!superseded && !o.dry_run && o.pr && head !== 'local') {
      for (const post of [post_status, post_gate_status]) {
        try { await post(client, head, 'error', 'Review failed; eligibility could not be established'); }
        catch (e) { warn(`Could not publish error status: ${e}`); }
      }
    }
    return {exitCode: 1, report: {pr: o.pr ?? null, head, phase: lifecycle.phase, error: error instanceof Error ? error.message : String(error)}};
  }
}
