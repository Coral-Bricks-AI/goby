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
import { issueRecord, reviewRecord, runProduct, runRecord } from './records.ts';

export interface Window { since: string; days: number }

/**
 * How many pages of 100 a single walk reads before giving up on reaching the window boundary.
 *
 * This is not `--limit`: it bounds pages scanned, not records kept, because a walk can spend its
 * whole budget on pages that contribute nothing — a pull request with no goby review still costs
 * a page's share of the walk. 50 pages is 5,000 items, comfortably above www's busiest month
 * (roughly 1,700 pull-request updates) with room for a repository several times busier, while
 * still bounding the work a single run can do against the job's own time and rate-limit budget.
 */
const PAGE_CAP = 50;

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
  for (let page = 1; page <= PAGE_CAP; page++) {
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
    // The walk used up its page budget before reaching the window or a short page: the window is
    // not fully read, and silence here would print an empty-looking answer as a complete one.
    if (page === PAGE_CAP) notes.push(`pull request walk truncated at ${PAGE_CAP} pages of 100`);
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
  for (let page = 1; page <= PAGE_CAP; page++) {
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
    // `state=all` and no server-side `since` means a renamed-nothing-returned walk is bounded only
    // by this cap; a busy backlog can spend it all on pages whose issues are not goby's.
    if (page === PAGE_CAP) notes.push(`issue walk truncated at ${PAGE_CAP} pages of 100`);
  }
  return out;
}

/**
 * goby's workflow runs, asked for by workflow rather than by repository.
 *
 * `/actions/runs` returns every workflow's runs newest-first, so a busy repository spends the whole
 * page budget on other people's CI: www creates hundreds of runs a day, and reading ten pages of
 * them covered barely a day, silently — the chart showed workflow activity for the last afternoon
 * of a seven-day window because nothing said the walk had stopped early.
 *
 * Asking each goby workflow for its own runs is exact and cheap, and it also means the cap is about
 * goby's runs rather than about how busy the repository is.
 */
export async function collectRuns(client: GitHubClient, window: Window, limit: number,
                                  notes: string[]): Promise<Collected['runs']> {
  const out: Collected['runs'] = [];
  const listed = JSON.parse(await client.get(`/repos/${client.repo}/actions/workflows?per_page=100`));
  const workflows = Array.isArray(listed?.workflows) ? listed.workflows : null;
  if (workflows === null) {
    notes.push('workflows could not be listed; no runs');
    return out;
  }
  const ours = workflows.filter((workflow: Record<string, unknown>) =>
    runProduct(String(workflow?.name ?? '')) !== null);
  if (!ours.length) return out;
  for (const workflow of ours) {
    for (let page = 1; page <= PAGE_CAP; page++) {
      const data = JSON.parse(await client.get(
        `/repos/${client.repo}/actions/workflows/${workflow.id}/runs` +
        `?created=${encodeURIComponent(`>=${window.since}`)}&per_page=100&page=${page}`));
      const rows = data?.workflow_runs;
      if (!Array.isArray(rows) || !rows.length) break;
      for (const run of rows) {
        if (out.length >= limit) { notes.push(`runs truncated at ${limit}`); return out; }
        out.push(runRecord(run));
      }
      if (rows.length < 100) break;
      if (page === PAGE_CAP) {
        notes.push(`${workflow.name ?? workflow.id} runs truncated at ${PAGE_CAP} pages of 100`);
      }
    }
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
