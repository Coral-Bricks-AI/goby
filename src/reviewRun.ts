/**
 * The two halves of a review that talk to GitHub, run by the container's root side.
 *
 *   reviewRun.ts prepare   before the agent: pin head/base, announce the run, collect what the
 *                          reviewer must not repeat, and decide whether this head was already
 *                          reviewed.
 *   reviewRun.ts finish    after the agent: turn its findings into threads, a receipt and a gate
 *                          verdict.
 *
 * Everything between them happens as an unprivileged uid with no token and no key. That split is
 * the whole design: the process that can write to the pull request never runs code from it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve_gate_target, type GateTarget } from './core/gateEvent.ts';
import { caveat_for } from './core/caveat.ts';
import { gate_enabled } from './core/flags.ts';
import { resolve_digest } from './core/image.ts';
import { check_target } from './core/target.ts';
import * as contract from './core/contract.ts';
import { select } from './core/selection.ts';
import { build_summary } from './core/summary.ts';
import { assertHead, HeadChanged, loadReceipt, refreshGate } from './core/gate.ts';
import { diffDigest, receiptMarker, type ReviewReceipt } from './core/verdict.ts';
import { REVIEW_VERSION } from './identity.ts';
import { GitHubClient } from './platforms/github.ts';
import { post_gate_status, post_review, post_status, reply_in_thread, resolve_thread } from './platforms/publish.ts';

/** A resolved thread carries the text that resolved it; the model needs it to judge a re-report. */
type ResolvedThread = contract.ThreadRecord & { resolution?: string };

interface Job {
  pr: number;
  repo: string;
  head: string;
  base: string;
  model: string;
  session: string;
  image: string | null;
  image_digest: string | null;
  diff_digest: string;
  diff_lines: number;
  intent: { title?: string | null; body?: string | null } | null;
  already_raised: string[];
  already_resolved: string[];
  open_threads: contract.ThreadRecord[];
  resolved_history: ResolvedThread[];
  reuse: boolean;
  /** Why the reviewer did not run, when it did not. */
  reuse_reason: string | null;
  incomplete: string[];
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
function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) : 0;
}

async function prepare(out: string, client: GitHubClient): Promise<number> {
  const pr = intEnv('GOBY_PR', 0);
  if (pr < 1) throw new Error('GOBY_PR must be a positive integer');
  const head = env('GOBY_HEAD');
  const base = env('GOBY_BASE');
  const diff = await readFile(join(out, 'diff.patch'), 'utf8');
  // The gate compares this digest against the API's diff for the same head and base, so it is
  // computed from that same call rather than from the clone: a local `git diff` is a different
  // set of bytes, and a receipt the gate can never match would block every merge.
  const digest = diffDigest(await client.fetch_diff(pr));

  // Same guard the old pipeline had: read the head, fetch, read it again. A review of a moving
  // head posts findings onto lines that no longer exist.
  let stable = false;
  let baseRef = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await client.fetch_pr_meta(pr);
    const wrong = check_target(before, { head, base });
    if (wrong) throw new Error(wrong);
    baseRef = before.base_ref;
    const after = await client.fetch_pr_meta(pr);
    if (after.head_sha === head && after.base_sha === base) { stable = true; break; }
  }
  if (!stable) throw new Error('PR head/base moved while preparing; nothing reviewed');

  const previous = await loadReceipt(client, pr, head);
  // The receipt names the base *ref*, so that is what a reuse decision compares.
  const sameHead = Boolean(previous?.complete && previous.base_ref === baseRef && previous.diff_sha256 === digest);

  // One review per pull request, by default: a later push does not start a second round. Fixes after
  // that are the cleaner's job, and a reviewer that keeps reading the same change costs a model call
  // per push to say the same thing again.
  const maxRounds = intEnv('GOBY_MAX_ROUNDS', 1);
  const reviewedHeads = maxRounds <= 1 ? await client.own_review_heads(pr).catch(() => []) : [];
  const alreadyReviewed = reviewedHeads.length > 0 && !reviewedHeads.includes(head);
  const reuse = sameHead || alreadyReviewed;
  const reuseReason = sameHead ? 'this commit was already reviewed'
    : alreadyReviewed ? `this pull request was already reviewed at ${reviewedHeads[0].slice(0, 10)}; it is reviewed once, and the post-merge cleaner takes it from there`
    : null;
  if (!reuse) {
    if (gate_enabled()) await post_gate_status(client, head, 'pending', 'Review in progress');
    await post_status(client, head, 'pending', 'Review in progress');
  }

  // A failed read is not "no threads": both of these suppress repeats, so losing one has to be
  // visible in the review body rather than quietly filing the same bug again.
  const incomplete: string[] = [];
  const [opened, history] = await Promise.all([
    client.fetch_open_own_threads(pr).catch(() => {
      incomplete.push('open review threads could not be read, so repeat suppression was off.');
      return [] as contract.ThreadRecord[];
    }),
    client.fetch_resolved_own_threads(pr).catch(() => {
      incomplete.push('resolved thread history could not be read, so resolved bugs may be re-reported.');
      return [] as ResolvedThread[];
    }) as Promise<ResolvedThread[]>,
  ]);
  history.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  let intent: Job['intent'] = null;
  try { intent = await client.fetch_pr_intent(pr); } catch { /* intent is a guard, not evidence */ }

  const raised = opened.filter(t => !t.outdated).map(t => `- \`${contract.format_thread_position(t)}\` — ${t.title}`);
  const resolved = history.slice(0, 40).map(t => `- \`${contract.format_thread_position(t)}\` — ${t.title}${t.resolution ? ` (resolved: ${t.resolution})` : ''}`);
  if (history.length > 40) resolved.push(`- (${history.length - 40} older resolved thread(s) omitted — this is the most recent history, not all of it.)`);

  // Resolved before the agent runs, so the digest in the review is the image this review used, not
  // whatever the tag points at by the time it finishes.
  const image = optionalEnv('GOBY_IMAGE') ?? null;
  const imageDigest = image ? await resolve_digest(image, optionalEnv('GITHUB_TOKEN')) : null;
  if (image) console.error(`image ${image}${imageDigest ? ` (${imageDigest})` : ' (digest unresolved)'}`);
  const job: Job = {
    pr, repo: client.repo, head, base: baseRef, model: env('GOBY_MODEL'), session: `review-pr${pr}-${head.slice(0, 10)}`,
    image, image_digest: imageDigest,
    diff_digest: digest, diff_lines: lineCount(diff), intent,
    already_raised: raised, already_resolved: resolved,
    open_threads: opened, resolved_history: history, reuse, reuse_reason: reuseReason, incomplete,
  };
  await writeFile(join(out, 'job.json'), JSON.stringify(job, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'prepared', reuse, open_threads: opened.length, resolved_history: history.length, diff_lines: job.diff_lines, diff_digest: digest }));
  return 0;
}

async function finish(out: string, client: GitHubClient, warn: (m: string) => void): Promise<number> {
  const job = JSON.parse(await readFile(join(out, 'job.json'), 'utf8')) as Job;
  const diff = await readFile(join(out, 'diff.patch'), 'utf8');
  const maxFindings = intEnv('GOBY_MAX_FINDINGS', 30);

  if (job.reuse) {
    await post_status(client, job.head, 'success', job.reuse_reason ?? 'Complete review reused on unchanged head');
    if (!gate_enabled()) {
      console.log(JSON.stringify({ phase: 'reused', gate: 'off' }));
      return 0;
    }
    const gate = await refreshGate(client, job.pr, { expected_head: job.head });
    console.log(JSON.stringify({ phase: 'reused', gate: gate.state }));
    return gate.state === 'success' ? 0 : 2;
  }

  const agentOut = optionalEnv('GOBY_AGENT_OUT') ?? join(out, 'agent');
  const records = (await readFile(join(agentOut, 'findings.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const emitted: unknown[] = [];
  // Two different things, kept apart on purpose. "Incomplete" means the evidence cannot be
  // trusted — a failed thread read, or a reviewer that never reported — and the gate refuses it.
  // A spent tool budget means the scan was bounded: the reviewer answered, and saying otherwise
  // would block every large pull request on a cap we chose.
  const incomplete: string[] = [...job.incomplete];
  const caveats: string[] = [];
  for (const record of records) {
    // One blocked record per blocked tool call, so the same sentence arrives many times; the reader
    // needs it once.
    const caveat = caveat_for(record);
    if (caveat && !caveats.includes(caveat)) caveats.push(caveat);
    if (record.kind !== 'findings' || !Array.isArray(record.findings)) continue;
    emitted.push(...(record.findings as unknown[]));
  }
  const parsed = contract.parse_findings(JSON.stringify(emitted), true);
  if (parsed === null) throw new Error('report_findings produced an off-contract payload; refusing to post');

  const picked = select(parsed, {
    diff, open_threads: job.open_threads, resolved_history: job.resolved_history, max_findings: maxFindings,
  });
  const complete = incomplete.length === 0;
  const receipt: ReviewReceipt = {
    schema: 2, head_sha: job.head, base_ref: job.base, diff_sha256: job.diff_digest,
    complete, agent: true, unthreaded: picked.overflow.length + picked.dropped.cap,
    finding_ids: picked.inline.map(f => f.fid),
  };
  // Every record carries the running count; the last one is the total.
  const toolCalls = records.reduce((n, record) => Math.max(n, Number(record.tool_calls ?? 0)), 0);
  const elapsedS = Number(optionalEnv('GOBY_ELAPSED_S') ?? 0);
  const summary = build_summary(picked.inline, picked.overflow, picked.withheld,
    {
      model: job.model, head: job.head, base: job.base, diffLines: lineCount(diff), elapsedS, toolCalls,
      image: job.image, imageDigest: job.image_digest,
      droppedPaths: picked.dropped.paths, droppedCap: picked.dropped.cap, droppedDupe: picked.dropped.dupe,
      droppedResolved: picked.dropped.resolved, droppedRetracted: picked.dropped.retracted,
      incomplete: complete ? null : incomplete.join(' '),
      caveat: caveats.length ? caveats.join(' ') : null,
    }, REVIEW_VERSION) + '\n\n' + receiptMarker(receipt);

  await assertHead(client, job.pr, job.head);
  await post_review(client, job.pr, job.head, summary, picked.inline);
  const found = picked.inline.length + picked.overflow.length;
  const description = found ? `${found} new bug(s) found` : 'no bugs found';
  await post_status(client, job.head, 'success', description);
  await cleanup(client, job.pr, job.open_threads, warn);
  if (!gate_enabled()) {
    // No gate: the review posts its findings and says nothing about merge eligibility, so a policy
    // about evidence cannot fail a pull request that nobody asked to gate.
    console.log(JSON.stringify({
      phase: 'finished', inline: picked.inline.length, overflow: picked.overflow.length, caveats,
      withheld: { already_open: picked.dropped.dupe, resolved: picked.dropped.resolved },
      dropped: picked.dropped, complete, gate: 'off',
    }));
    return 0;
  }
  const gate = await refreshGate(client, job.pr, { expected_head: job.head });
  console.log(JSON.stringify({
    phase: 'finished', inline: picked.inline.length, overflow: picked.overflow.length, caveats,
    withheld: { already_open: picked.dropped.dupe, resolved: picked.dropped.resolved },
    dropped: picked.dropped, complete, gate: gate.state,
  }));
  return gate.state === 'success' ? 0 : 2;
}

// Resolution cleanup is best-effort by design: a stale thread that cannot be resolved must not
// fail a review that otherwise produced evidence.
async function cleanup(client: GitHubClient, pr: number, threads: readonly contract.ThreadRecord[], warn: (m: string) => void): Promise<void> {
  for (const [thread, note] of contract.plan_thread_resolution(threads)) {
    try {
      await resolve_thread(client, String(thread.thread_id));
      try { await reply_in_thread(client, pr, Number(thread.comment_id), note); } catch (error) { warn(`Resolution reply failed: ${error}`); }
    } catch (error) { warn(`Thread cleanup failed: ${error}`); }
  }
}

/**
 * Too big to review in one pass. Not an error and not a clean bill of health: the review says it
 * skipped, and the gate fails closed because there is no receipt to stand on.
 */
async function skip(client: GitHubClient): Promise<number> {
  const pr = intEnv('GOBY_PR', 0);
  const head = env('GOBY_HEAD');
  const reason = env('GOBY_SKIP_REASON');
  await post_status(client, head, 'success', `Skipped: ${reason}`);
  // With the gate off there is no eligibility claim to contradict; the review status says skipped.
  if (gate_enabled()) await post_gate_status(client, head, 'failure', `Skipped: ${reason}`);
  console.log(JSON.stringify({ phase: 'skipped', reason }));
  return 0;
}

/**
 * Recheck eligibility without a model, from whatever triggered this run.
 *
 * The target comes from the event file rather than from inputs, so a `workflow_run` handoff needs
 * no inline scripting in the workflow — and the resolution has a test.
 */
async function gate(client: GitHubClient): Promise<number> {
  const eventPath = optionalEnv('GOBY_EVENT_FILE');
  const target = eventPath
    ? resolve_gate_target({
      name: env('GITHUB_EVENT_NAME'),
      event: JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>,
      inputs: { pr: optionalEnv('GOBY_PR'), head: optionalEnv('GOBY_HEAD') },
    })
    : ({ pr: intEnv('GOBY_PR', 0), head: env('GOBY_HEAD') } as GateTarget);
  if (typeof target === 'string') {
    console.log(JSON.stringify({ phase: 'gate', skipped: target }));
    return 0;
  }
  const result = await refreshGate(client, target.pr, { expected_head: target.head });
  console.log(JSON.stringify({ phase: 'gate', pr: target.pr, head: target.head, state: result.state }));
  return result.state === 'success' ? 0 : result.state === 'error' ? 1 : 2;
}

/**
 * The reviewer never answered. Say so on both statuses: leaving them "pending" blocks the pull
 * request forever with nothing to read, which is worse than a visible failure.
 */
async function fail(client: GitHubClient): Promise<number> {
  const reason = env('GOBY_FAIL_REASON');
  await post_status(client, env('GOBY_HEAD'), 'error', `Review failed: ${reason}`);
  await post_gate_status(client, env('GOBY_HEAD'), 'error', `Review failed: ${reason}`);
  console.log(JSON.stringify({ phase: 'failed', reason }));
  return 1;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (!['prepare', 'finish', 'skip', 'gate', 'merge-base', 'fail'].includes(mode ?? '')) {
    throw new Error('usage: reviewRun.ts prepare|finish|skip|gate|merge-base|fail');
  }
  if (mode === 'merge-base') {
    // Printed alone, so the entrypoint can fetch exactly these commits and nothing else.
    console.log(await new GitHubClient(env('GOBY_REPO'), env('GITHUB_TOKEN')).fetch_merge_base(env('GOBY_BASE'), env('GOBY_HEAD')));
    return 0;
  }
  const out = env('GOBY_OUT');
  const client = new GitHubClient(env('GOBY_REPO'), env('GITHUB_TOKEN'));
  if (mode === 'skip') return skip(client);
  if (mode === 'gate') return gate(client);
  if (mode === 'fail') return fail(client);
  return mode === 'prepare' ? prepare(out, client) : finish(out, client, message => console.error(message));
}

main().then(code => { process.exitCode = code; }, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof HeadChanged ? `superseded: ${message}` : message);
  process.exitCode = 1;
});
