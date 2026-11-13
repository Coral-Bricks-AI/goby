/**
 * Reading GitHub: the three lists `goby wake` turns into records.
 *
 * All of it is read-only and all of it is the repository's own history — the pull requests, the
 * issues the products filed, and the workflow runs. Nothing is stored anywhere: the window is the
 * argument, and the same command run twice returns the same records.
 *
 * Two disciplines, both learned from the review side of this repository:
 *
 * - **A truncated read is not an empty one.** Every function reports what it could not read, in
 *   `notes`, instead of returning a short list that reads as "nothing happened". A graph drawn
 *   from a silently capped window is worse than no graph.
 * - **A cap is stated.** `--limit` bounds the work; when it bites, the output says so.
 */
import type { GitHubClient, ThreadRecord } from '../platforms/github.ts';
import { issueRecord, reviewRecord, runRecord } from './records.ts';

export interface Window { since: string; days: number }

export interface Collected {
  reviews: ReturnType<typeof reviewRecord>[];
  issues: NonNullable<ReturnType<typeof issueRecord>>[];
  runs: ReturnType<typeof runRecord>[];
  /** Everything this run could not read, or cut short. Empty means the window is the window. */
  notes: string[];
}

/** The workflow name a product runs under, for the job that never ran at all. */
const PRODUCT_MARKERS = ['goby-cleaners', 'goby-tide'];

export async function collectReviews(client: GitHubClient, window: Window, limit: number,
                                     notes: string[]): Promise<Collected['reviews']> {
  const out: Collected['reviews'] = [];
  const since = Date.parse(window.since);
  for (let page = 1; page <= 10; page++) {
    // Ordered by `updated` because that is the only order GitHub offers that bounds the walk:
    // a pull request reviewed in the window has been updated since, so the scan can stop at the
    // first page whose oldest entry predates it.
    const rows = JSON.parse(await client.get(
      `/repos/${client.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`));
    if (!Array.isArray(rows) || !rows.length) break;
    let reached = false;
    for (const pr of rows) {
      if (Date.parse(String(pr.updated_at ?? pr.created_at ?? '')) < since) { reached = true; break; }
      const reviews = await client.own_reviews(Number(pr.number)).catch(() => null);
      if (reviews === null) { notes.push(`pull request #${pr.number}: reviews could not be read`); continue; }
      if (!reviews.length) continue;
      // Threads are per pull request, read once: `fetch_thread_state` walks the whole conversation
      // and reports whether the walk was complete, which a per-review query could not.
      const [open, resolved, complete] = await client.fetch_thread_state(Number(pr.number))
        .catch(() => [[], [], false] as [ThreadRecord[], ThreadRecord[], boolean]);
      if (!complete) notes.push(`pull request #${pr.number}: review threads could not be read in full`);
      for (const review of reviews) {
        if (Date.parse(review.submitted_at) < since) continue;
        if (out.length >= limit) { notes.push(`reviews truncated at ${limit}`); return out; }
        out.push(reviewRecord(Number(pr.number), review, [...open, ...resolved], complete));
      }
    }
    // A short page is the last page. Without this the walk costs ten requests to learn nothing,
    // and every one of them re-reads the same pull requests.
    if (reached || rows.length < 100) break;
  }
  return out;
}

export async function collectIssues(client: GitHubClient, window: Window, limit: number,
                                    notes: string[]): Promise<Collected['issues']> {
  const out: Collected['issues'] = [];
  const since = Date.parse(window.since);
  const now = Date.now();
  // The general label finds every product's issues in one walk, which is why `goby` exists.
  // `state=all` and no `since` on purpose: an issue still open is the backlog, whatever year it
  // was filed in, and a window that hid the oldest ones would make the backlog look healthy.
  for (let page = 1; page <= 10; page++) {
    const rows = JSON.parse(await client.get(
      `/repos/${client.repo}/issues?state=all&labels=goby&sort=updated&direction=desc&per_page=100&page=${page}`));
    if (!Array.isArray(rows) || !rows.length) break;
    for (const issue of rows) {
      if (issue.pull_request) continue;
      const labels = (issue.labels ?? []).map((label: unknown) =>
        typeof label === 'string' ? label : String((label as Record<string, unknown>)?.name ?? ''));
      if (!labels.some((label: string) => PRODUCT_MARKERS.includes(label))) continue;
      const closed = issue.closed_at ? Date.parse(String(issue.closed_at)) : null;
      // Closed before the window and still in the list: it is history, not an outcome of this
      // window's runs.
      if (closed !== null && closed < since) continue;
      const record = issueRecord(issue, now);
      if (!record) { notes.push(`issue #${issue.number}: no readable marker`); continue; }
      if (out.length >= limit) { notes.push(`issues truncated at ${limit}`); return out; }
      out.push(record);
    }
    if (rows.length < 100) break;
  }
  return out;
}

export async function collectRuns(client: GitHubClient, window: Window, limit: number,
                                  notes: string[]): Promise<Collected['runs']> {
  const out: Collected['runs'] = [];
  for (let page = 1; page <= 10; page++) {
    const data = JSON.parse(await client.get(
      `/repos/${client.repo}/actions/runs?created=${encodeURIComponent(`>=${window.since}`)}` +
      `&per_page=100&page=${page}`));
    const rows = data?.workflow_runs;
    if (!Array.isArray(rows) || !rows.length) break;
    for (const run of rows) {
      const record = runRecord(run);
      if (record.product === null) continue;
      if (out.length >= limit) { notes.push(`runs truncated at ${limit}`); return out; }
      out.push(record);
    }
    if (rows.length < 100) break;
  }
  return out;
}

export async function collect(client: GitHubClient, window: Window, limit: number): Promise<Collected> {
  const notes: string[] = [];
  // Reviews are the expensive half — one request per pull request, plus a thread query — so a
  // failure there must not cost the issue and run lists. Each is collected on its own and its
  // failure is reported, because a view missing one third of its data should say which third.
  const reviews = await collectReviews(client, window, limit, notes)
    .catch((error) => { notes.push(`reviews unavailable: ${message(error)}`); return []; });
  const issues = await collectIssues(client, window, limit, notes)
    .catch((error) => { notes.push(`issues unavailable: ${message(error)}`); return []; });
  const runs = await collectRuns(client, window, limit, notes)
    .catch((error) => { notes.push(`runs unavailable: ${message(error)}`); return []; });
  return { reviews, issues, runs, notes };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
