/**
 * The GitHub-talking half of `code/`, run by the container's root side — same split as
 * `reviewRun.ts`: the agent that touches the task's code runs unprivileged, with no token and no
 * key, and everything that can write to the repository is a separate step in this file.
 *
 *   codeRun.ts prepare  before the agent: resolve the task text, parse the allowed-path globs,
 *                       and name the branch this run would open.
 *   codeRun.ts commit   after the agent: scope-check its changes against the allow-list, and on
 *                       success turn them into a branch, a commit and a pull request. On a scope
 *                       violation, nothing is pushed and nothing is opened — the run escalates.
 *   codeRun.ts threads  one round of the fix loop: read the open threads on the pull request this
 *                       run opened, and report the round decision (continue / stop / escalate).
 *   codeRun.ts reply    reply to one thread (a fix commit's sha, or a reason) and resolve it.
 *   codeRun.ts escalate leave the pull request as a draft and post why the loop stopped.
 *   codeRun.ts fail     say why this run produced no pull request at all.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { code_branch_name, parse_allowed_paths, resolve_task_source, round_decision } from './core/codePlan.ts';
import { out_of_scope } from './core/scope.ts';
import { GitHubClient } from './platforms/github.ts';
import { open_pull_request, reply_in_thread, resolve_thread } from './platforms/publish.ts';

interface ChangedFile {
  path: string;
  /** Null means deleted. */
  content: string | null;
}

interface Job {
  repo: string;
  base_ref: string;
  base_sha: string;
  branch: string;
  task_text: string;
  task_source: 'inline' | 'file';
  allow_globs: string[];
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}
function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

/**
 * Resolves the task to its text. An inline task is used as-is; a `.goby/tasks/` task is read from
 * the consumer repository's clone, which the entrypoint has at `GOBY_REPO_DIR` by this point —
 * the file lives in the repo the run is acting on, not in the image.
 */
async function resolveTask(repoDir: string): Promise<{ text: string; source: 'inline' | 'file' }> {
  const raw = env('GOBY_TASK');
  const resolved = resolve_task_source(raw);
  if (resolved.inline) return { text: resolved.text, source: 'inline' };
  const { join } = await import('node:path');
  const text = await readFile(join(repoDir, resolved.path), 'utf8').catch(error => {
    throw new Error(`task file ${resolved.path} could not be read from ${repoDir}: ${error}`);
  });
  return { text, source: 'file' };
}

async function prepare(out: string): Promise<number> {
  const repoDir = env('GOBY_REPO_DIR');
  const base_ref = env('GOBY_BASE_REF');
  const base_sha = env('GOBY_BASE_SHA');
  const { text, source } = await resolveTask(repoDir);
  const allow_globs = parse_allowed_paths(env('GOBY_ALLOWED_PATHS'));
  const branch = code_branch_name(base_sha, optionalEnv('GOBY_INSTANCE'));
  const job: Job = {
    repo: env('GOBY_REPO'), base_ref, base_sha, branch,
    task_text: text, task_source: source, allow_globs,
  };
  const { join } = await import('node:path');
  await writeFile(join(out, 'job.json'), JSON.stringify(job, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'prepared', branch, task_source: source, allow_globs }));
  return 0;
}

/** Reads the manifest the entrypoint wrote from diffing the sandbox against the reference tree. */
async function readChanges(path: string): Promise<ChangedFile[]> {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('changes manifest must be an array');
  return raw.map((entry: Record<string, unknown>) => ({
    path: String(entry.path), content: entry.content === null ? null : String(entry.content),
  }));
}

/**
 * Scope-check, then branch + commit + pull request — all through the git-data API, never a local
 * `git push`: the process holding the token is the one making every write, same as a review's
 * comments and statuses, so a scope violation is caught before anything leaves this process.
 */
async function commit(out: string, client: GitHubClient): Promise<number> {
  const { join } = await import('node:path');
  const job = JSON.parse(await readFile(join(out, 'job.json'), 'utf8')) as Job;
  const changesPath = optionalEnv('GOBY_CHANGES_FILE') ?? join(out, 'changes.json');
  const changes = await readChanges(changesPath);
  if (changes.length === 0) {
    console.log(JSON.stringify({ phase: 'no-changes' }));
    return 3;
  }

  const violations = out_of_scope(changes.map(c => c.path), job.allow_globs);
  if (violations.length > 0) {
    const message = `Out of scope: the task would touch path(s) outside the allowed list and was ` +
      `stopped before anything was pushed.\n\nAllowed:\n${job.allow_globs.map(g => `- \`${g}\``).join('\n') || '(none)'}` +
      `\n\nOut of scope:\n${violations.map(v => `- \`${v}\``).join('\n')}`;
    await writeFile(join(out, 'escalation.md'), message + '\n');
    console.log(JSON.stringify({ phase: 'out-of-scope', violations }));
    return 2;
  }

  const baseCommit = JSON.parse(await client.get(`/repos/${job.repo}/git/commits/${job.base_sha}`));
  const baseTree = baseCommit?.tree?.sha;
  if (typeof baseTree !== 'string') throw new Error('could not read the base commit tree');

  const entries = [];
  for (const change of changes) {
    const sha = change.content === null ? null : await client.create_blob(change.content, 'utf-8');
    entries.push({ path: change.path, sha });
  }
  const tree = await client.create_tree(baseTree, entries);
  const summary = optionalEnv('GOBY_DONE_SUMMARY') ?? 'Automated change';
  const message = `goby/code: ${summary}`;
  const commitSha = await client.create_commit(message, tree, [job.base_sha]);
  await client.create_branch(job.branch, commitSha);
  const pr = await open_pull_request(client, {
    base: job.base_ref, head: job.branch, title: `goby/code: ${summary}`,
    body: buildPrBody(job, summary),
  });
  await writeFile(join(out, 'pr.json'), JSON.stringify({ number: pr.number, node_id: pr.node_id, html_url: pr.html_url, head_sha: commitSha }, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'opened', pr: pr.number, url: pr.html_url }));
  return 0;
}

function buildPrBody(job: Job, summary: string): string {
  const source = job.task_source === 'file' ? ' (from a `.goby/tasks/` file)' : '';
  return [
    `**goby/code**${source}`, '',
    summary, '',
    '<details><summary>Task</summary>', '', '```', job.task_text.trim(), '```', '</details>', '',
    `Allowed paths: ${job.allow_globs.map(g => `\`${g}\``).join(', ') || '(none)'}`,
  ].join('\n');
}

/**
 * A fix commit on top of the pull request's current head, for the review-thread loop. Same
 * scope-check as `commit` — defense in depth, since a fix round can propose paths the first one
 * never touched — and the same git-data path: a new tree off the current head's tree, a commit
 * whose sole parent is that head, and the branch ref moved to it.
 */
async function fix(out: string, client: GitHubClient): Promise<number> {
  const { join } = await import('node:path');
  const job = JSON.parse(await readFile(join(out, 'job.json'), 'utf8')) as Job;
  const pr = JSON.parse(await readFile(join(out, 'pr.json'), 'utf8')) as { number: number; node_id: string; html_url: string; head_sha: string };
  const changesPath = optionalEnv('GOBY_CHANGES_FILE') ?? join(out, 'changes.json');
  const changes = await readChanges(changesPath);
  if (changes.length === 0) {
    console.log(JSON.stringify({ phase: 'no-fix-changes' }));
    return 3;
  }
  const violations = out_of_scope(changes.map(c => c.path), job.allow_globs);
  if (violations.length > 0) {
    await writeFile(join(out, 'escalation.md'), `Out of scope during the fix round:\n${violations.map(v => `- \`${v}\``).join('\n')}\n`);
    console.log(JSON.stringify({ phase: 'out-of-scope', violations }));
    return 2;
  }
  const headCommit = JSON.parse(await client.get(`/repos/${job.repo}/git/commits/${pr.head_sha}`));
  const headTree = headCommit?.tree?.sha;
  if (typeof headTree !== 'string') throw new Error('could not read the pull request head commit tree');
  const entries = [];
  for (const change of changes) {
    const sha = change.content === null ? null : await client.create_blob(change.content, 'utf-8');
    entries.push({ path: change.path, sha });
  }
  const tree = await client.create_tree(headTree, entries);
  const summary = optionalEnv('GOBY_DONE_SUMMARY') ?? 'Address review feedback';
  const commitSha = await client.create_commit(`goby/code: ${summary}`, tree, [pr.head_sha]);
  await client.update_ref(job.branch, commitSha);
  await writeFile(join(out, 'pr.json'), JSON.stringify({ ...pr, head_sha: commitSha }, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'fixed', pr: pr.number, sha: commitSha }));
  return 0;
}

/** One round: read the open threads on the pull request this run opened, print the decision. */
async function threads(out: string, client: GitHubClient): Promise<number> {
  const { join } = await import('node:path');
  const pr = JSON.parse(await readFile(join(out, 'pr.json'), 'utf8')) as { number: number };
  const round = intEnv('GOBY_ROUND', 1);
  const maxRounds = intEnv('GOBY_CODE_MAX_ROUNDS', 3);
  const open = await client.fetch_open_own_threads(pr.number);
  const decision = round_decision({ round, maxRounds, openThreads: open.length });
  await writeFile(join(out, 'threads.json'), JSON.stringify(open, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'threads', round, maxRounds, open: open.length, ...decision }));
  return decision.escalate ? 2 : 0;
}

/** Replies to one thread, then resolves it. Called once per thread the agent judged in this round. */
async function reply(client: GitHubClient): Promise<number> {
  const pr = intEnv('GOBY_PR', 0);
  const threadId = env('GOBY_THREAD_ID');
  const commentId = intEnv('GOBY_COMMENT_ID', 0);
  const note = env('GOBY_REPLY_NOTE');
  await reply_in_thread(client, pr, commentId, note);
  await resolve_thread(client, threadId);
  console.log(JSON.stringify({ phase: 'replied', pr, threadId }));
  return 0;
}

/**
 * The round cap was reached with threads still open. The pull request stays as a draft and the
 * escalation is a comment, not a merge or a silent stop — review/code/INVARIANTS.md.
 */
async function escalate(out: string, client: GitHubClient): Promise<number> {
  const { join } = await import('node:path');
  const pr = JSON.parse(await readFile(join(out, 'pr.json'), 'utf8')) as { number: number; node_id: string };
  const reason = env('GOBY_ESCALATION_REASON');
  await client.post(`/repos/${env('GOBY_REPO')}/issues/${pr.number}/comments`, {
    body: `**goby/code escalation**\n\n${reason}\n\nLeaving this pull request as a draft.`,
  });
  await client.convert_to_draft(pr.node_id);
  console.log(JSON.stringify({ phase: 'escalated', pr: pr.number, reason }));
  return 0;
}

/** No pull request exists yet (the scope check refused it, or the agent produced no change). */
async function fail(reason: string): Promise<number> {
  console.error(JSON.stringify({ phase: 'failed', reason }));
  return 1;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (!['prepare', 'commit', 'fix', 'threads', 'reply', 'escalate', 'fail'].includes(mode ?? '')) {
    throw new Error('usage: codeRun.ts prepare|commit|fix|threads|reply|escalate|fail');
  }
  if (mode === 'fail') return fail(env('GOBY_FAIL_REASON'));
  const out = env('GOBY_OUT');
  if (mode === 'prepare') return prepare(out);
  const client = new GitHubClient(env('GOBY_REPO'), env('GITHUB_TOKEN'));
  if (mode === 'commit') return commit(out, client);
  if (mode === 'fix') return fix(out, client);
  if (mode === 'threads') return threads(out, client);
  if (mode === 'reply') return reply(client);
  return escalate(out, client);
}

main().then(code => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
