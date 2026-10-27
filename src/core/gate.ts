import {BOT_LOGINS, STATUS_CONTEXT, SUMMARY_PREFIX} from '../identity.ts';
import type {GitHubClient} from '../platforms/github.ts';
import {post_gate_status} from '../platforms/publish.ts';
import {diffDigest, evaluateGate, parseReceipt, type GateResult, type ReviewReceipt} from './verdict.ts';

export class HeadChanged extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub review response');
  return value as Record<string, unknown>;
}
export async function loadReceipt(client: GitHubClient, pr: number, head: string): Promise<ReviewReceipt | null> {
  let latest: Record<string, unknown> | null = null;
  const logins = ('botLogins' in client && Array.isArray(client.botLogins)) ? client.botLogins : BOT_LOGINS;
  for (let page = 1; page <= 20; page++) {
    const raw = await client.get(`/repos/${client.repo}/pulls/${pr}/reviews?per_page=100&page=${page}`);
    const rows: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(rows)) throw new Error('Invalid GitHub review response');
    for (const rawRow of rows) {
      const row = object(rawRow);
      const login = object(row.user).login;
      if (typeof login !== 'string' || !logins.includes(login) || row.commit_id !== head ||
          !['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(String(row.state)) ||
          typeof row.body !== 'string' || !row.body.startsWith(SUMMARY_PREFIX)) continue;
      if (!Number.isSafeInteger(row.id)) throw new Error('Invalid review identity');
      if (!latest || (row.id as number) > (latest.id as number)) latest = row;
    }
    if (rows.length < 100) return latest ? parseReceipt(latest.body as string, head) : null;
  }
  throw new Error('Review pagination cap reached; refusing partial evidence');
}
export async function assertHead(client: GitHubClient, pr: number, expected: string): Promise<void> {
  if ((await client.fetch_pr_meta(pr)).head_sha !== expected) throw new HeadChanged('PR head changed; rerun for the current commit');
}
async function snapshot(client: GitHubClient, pr: number, head: string): Promise<{result: GateResult; fingerprint: string}> {
  const before = await client.fetch_pr_meta(pr);
  if (before.head_sha !== head) throw new HeadChanged('PR head changed');
  const diff_sha256 = diffDigest(await client.fetch_diff(pr));
  const receipt = await loadReceipt(client, pr, head);
  const [opened, resolved, complete] = await client.fetch_thread_state(pr);
  const execution = await client.latest_status_state(head, STATUS_CONTEXT) === 'success';
  const after = await client.fetch_pr_meta(pr);
  if (after.head_sha !== head || after.base_ref !== before.base_ref) throw new HeadChanged('PR head or base changed during evidence acquisition');
  const evidence = {base_ref: before.base_ref, diff_sha256};
  const result = evaluateGate(receipt, head, opened, resolved, complete, execution, evidence);
  const threads = (items: typeof opened) => items.map(t => [t.thread_id, t.fid, t.sha]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {result, fingerprint: diffDigest(JSON.stringify({receipt, evidence, execution, complete, opened: threads(opened), resolved: threads(resolved)}))};
}
export async function refreshGate(client: GitHubClient, pr: number, options: {expected_head?: string; dry_run?: boolean} = {}): Promise<GateResult> {
  const head = options.expected_head ?? (await client.fetch_pr_meta(pr)).head_sha;
  await assertHead(client, pr, head);
  if (!options.dry_run) await post_gate_status(client, head, 'pending', 'Checking review evidence');
  let result: GateResult;
  let fingerprint: string | undefined;
  try {
    const evidence = await snapshot(client, pr, head);
    result = evidence.result; fingerprint = evidence.fingerprint;
  } catch (error) {
    result = {head_sha: head, state: 'error', description: `Cannot establish review eligibility: ${error instanceof Error ? error.message : String(error)}`};
  }
  await assertHead(client, pr, head);
  if (!options.dry_run) await post_gate_status(client, head, result.state, result.description);
  if (result.state === 'success') {
    // Commit statuses have no compare-and-swap operation. An old refresh can
    // race a newer negative verdict. Read back all evidence after publishing,
    // and revoke our success if it changed; never leave a settled stale green.
    // Merge-time protection and workflow concurrency still own the external
    // race between this final read and a future mutation.
    try {
      const current = await snapshot(client, pr, head);
      if (current.fingerprint !== fingerprint || current.result.state !== 'success') {
        result = {head_sha: head, state: 'failure', description: 'Review evidence changed during gate publication; recheck required'};
      }
    } catch (error) {
      result = {head_sha: head, state: 'error', description: `Gate publication could not be verified: ${error instanceof Error ? error.message : String(error)}`};
    }
    if (result.state !== 'success' && !options.dry_run) await post_gate_status(client, head, result.state, result.description);
  }
  return result;
}
