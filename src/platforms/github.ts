import { BOT_LOGINS, MARKER, SUMMARY_PREFIX } from '../identity.ts';

const API = 'https://api.github.com';
// JSON at the transport boundary is intentionally dynamic; exported records
// below have structural types so the pure review contract need not import I/O.
type JsonObject = Record<string, any>;
const object = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const position = (v: unknown): number | null => typeof v === 'number' ? v : null;
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
const content_line = (body: string): string => (body.split(/\r?\n/).find(
  line => line.trim() && !line.trimStart().startsWith('<!--'),
) ?? '').trim().replace(/^\*+|\*+$/g, '').trim();

export type ThreadRecord = {
  thread_id: string;
  comment_id: number;
  path: string;
  line: number | null;
  start_line: number | null;
  original_line: number | null;
  original_start_line: number | null;
  marker_start: number | null;
  marker_end: number | null;
  sha: string;
  outdated: boolean;
  created_at: string;
  title: string;
  fid: string;
  /** The severity goby wrote into the marker; empty when the comment carries none. */
  severity: string;
  resolution?: string;
  resolved?: boolean;
};

export class GitHubError extends Error {
  constructor(public readonly code: number, path: string, body: string) {
    super(`GitHub API ${code} on ${path}: ${cut(body, 300)}`);
    this.name = 'GitHubError';
  }
}

const THREAD_QUERY = `query($owner: String!, $name: String!, $n: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated
          comments(first: 10) {
            nodes {
              databaseId author { login } body path line startLine
              originalLine originalStartLine createdAt
            }
            pageInfo { hasNextPage }
          }
          lastComment: comments(last: 1) {
            nodes { databaseId author { login } body path line originalLine createdAt }
          }
        }
      }
    }
  }
}`;
const SUMMARY_QUERY = `query($owner: String!, $name: String!, $n: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviews(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id state isMinimized body author { login } }
      }
    }
  }
}`;

export class GitHubClient {
  private readonly fetcher: typeof fetch;
  private readonly bot_logins: ReadonlySet<string>;
  public readonly botLogins: string[];

  constructor(
    public readonly repo: string,
    public readonly token: string,
    options: { fetch?: typeof fetch; botLogins?: string[] } = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.botLogins = [...(options.botLogins ?? BOT_LOGINS)];
    this.bot_logins = new Set(this.botLogins);
  }

  private async request(path: string, method: string, accept: string, payload?: JsonObject): Promise<string> {
    try {
      const response = await this.fetcher(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`, Accept: accept,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.text();
      if (!response.ok) throw new GitHubError(response.status, path, body);
      return body;
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(0, path, error instanceof Error ? error.message : String(error));
    }
  }

  /** Raw UTF-8 response text, including for JSON endpoints (JSON.parse at the caller). */
  async get(path: string, accept = 'application/vnd.github+json'): Promise<string> {
    return this.request(path, 'GET', accept);
  }

  async post(path: string, payload: JsonObject): Promise<JsonObject> {
    return JSON.parse(await this.request(path, 'POST', 'application/vnd.github+json', payload));
  }

  async graphql(query: string, variables: JsonObject = {}): Promise<JsonObject> {
    const result = await this.post('/graphql', { query, variables });
    // HTTP 200 can still be a failed (or partial) GraphQL operation.
    if (result.errors && (!Array.isArray(result.errors) || result.errors.length)) {
      throw new GitHubError(200, '/graphql', JSON.stringify(result.errors));
    }
    return result;
  }

  async fetch_pr_meta(pr: number): Promise<{ head_sha: string; head_ref: string; base_ref: string; base_sha: string }> {
    const data = JSON.parse(await this.get(`/repos/${this.repo}/pulls/${pr}`));
    if (typeof data?.head?.sha !== 'string' || typeof data?.head?.ref !== 'string' ||
        typeof data?.base?.ref !== 'string' || typeof data?.base?.sha !== 'string') {
      throw new GitHubError(200, `/repos/${this.repo}/pulls/${pr}`, 'Missing PR head metadata');
    }
    return { head_sha: data.head.sha, head_ref: data.head.ref, base_ref: data.base.ref, base_sha: data.base.sha };
  }

  /**
   * The commit the pull request's diff is against.
   *
   * GitHub computes a PR diff against the merge base, not against the current base tip, and that
   * difference matters: diffing `base..head` after the base branch has moved includes the base's own
   * newer commits, reversed, which is how a reviewer reports changes nobody made. One compare call
   * gives the exact commit, so the clone needs three commits at depth 1 instead of a guessed depth of
   * history.
   */
  async fetch_merge_base(base: string, head: string): Promise<string> {
    const data = JSON.parse(await this.get(`/repos/${this.repo}/compare/${base}...${head}`));
    const sha = data?.merge_base_commit?.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
      throw new GitHubError(200, `/repos/${this.repo}/compare`, 'Missing merge base in compare response');
    }
    return sha;
  }

  async fetch_diff(pr: number): Promise<string> {
    return this.get(`/repos/${this.repo}/pulls/${pr}`, 'application/vnd.github.v3.diff');
  }

  /** Like Python, examines the first 100 statuses and selects by updated_at. */
  async latest_status_state(sha: string, context: string): Promise<string | null> {
    const data = JSON.parse(await this.get(`/repos/${this.repo}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`));
    let latest: JsonObject | undefined;
    for (const status of data) {
      if (object(status) && status.context === context &&
          (!latest || text(status.updated_at) > text(latest.updated_at))) latest = status;
    }
    return latest ? (latest.state ?? null) : null;
  }

  /**
   * The reviews this project has posted on a pull request: the commit each was for, and its body.
   *
   * Returned as records rather than heads because the caller has to tell a completed review from an
   * incomplete one: only a completed review spends the round, or a failed review on the first commit
   * would suppress every later push. The id and the submission time are here for the same reason a
   * reader wants them: a review is a point on a timeline, and it has to be identifiable afterwards.
   */
  async own_reviews(pr: number): Promise<{
    head: string; body: string; id: number | null; submitted_at: string;
  }[]> {
    const reviews: { head: string; body: string; id: number | null; submitted_at: string }[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = JSON.parse(await this.get(`/repos/${this.repo}/pulls/${pr}/reviews?per_page=100&page=${page}`));
      if (!Array.isArray(rows)) throw new Error('Invalid GitHub review response');
      for (const review of rows) {
        if (!object(review) || !this.bot_logins.has(review.user?.login)) continue;
        const body = text(review.body);
        // Ours means ours: the bot login is shared with every other workflow that posts as the app,
        // so a review from `github-actions` is only counted when it carries our summary or marker.
        // Otherwise an unrelated review would suppress this one for the whole pull request.
        if (!(body.startsWith(SUMMARY_PREFIX) || body.includes(`<!-- ${MARKER} head=`))) continue;
        if (!['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(String(review.state))) continue;
        if (typeof review.commit_id === 'string' && review.commit_id) {
          reviews.push({
            head: review.commit_id, body,
            id: position(review.id), submitted_at: text(review.submitted_at),
          });
        }
      }
      if (rows.length < 100) break;
    }
    return reviews;
  }

  private own_thread_record(node: JsonObject, resolved: boolean): ThreadRecord | null {
    const first = node.comments.nodes[0];
    const body = first.body as string;
    if (!this.bot_logins.has(first.author.login) || !body.includes(`<!-- ${MARKER} `)) return null;
    const field = (name: string): string => body.match(new RegExp(`<!-- ${MARKER} [^>]*\\b${name}=(\\w+)`))?.[1] ?? '';
    const marker_position = (name: string): number | null => {
      const match = body.match(new RegExp(`<!-- ${MARKER} [^>]*\\b${name}=(\\d+)`));
      return match ? Number(match[1]) : null;
    };
    const rec: ThreadRecord = {
      thread_id: node.id, comment_id: first.databaseId, path: text(first.path),
      line: position(first.line), start_line: position(first.startLine),
      original_line: position(first.originalLine), original_start_line: position(first.originalStartLine),
      marker_start: marker_position('start_line'), marker_end: marker_position('end_line'),
      sha: field('sha'), outdated: Boolean(node.isOutdated), created_at: text(first.createdAt),
      title: content_line(body), fid: body.match(new RegExp(`<!-- ${MARKER} id=(\\w+)`))?.[1] ?? '',
      severity: field('severity'),
    };
    if (resolved) {
      rec.line ??= rec.original_line;
      let last_nodes = node.lastComment?.nodes;
      if (!Array.isArray(last_nodes) || !last_nodes.length) {
        // Missing pageInfo is UNKNOWN, never proof that a prefix is complete.
        last_nodes = node.comments.pageInfo?.hasNextPage === false ? node.comments.nodes : [];
      }
      const last = last_nodes.at(-1);
      rec.resolution = last && last.databaseId !== first.databaseId ? cut(content_line(text(last.body)), 200) : '';
    }
    return rec;
  }

  private async fetch_own_threads(pr: number, resolved: boolean | null): Promise<[ThreadRecord[], boolean]> {
    const [owner, ...parts] = this.repo.split('/');
    const out: ThreadRecord[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const data = await this.graphql(THREAD_QUERY, { owner, name: parts.join('/'), n: pr, cursor });
      const threads = data?.data?.repository?.pullRequest?.reviewThreads;
      if (!object(threads) || !Array.isArray(threads.nodes) || !object(threads.pageInfo) ||
          typeof threads.pageInfo.hasNextPage !== 'boolean') return [out, false];
      for (const node of threads.nodes) {
        if (!object(node) || typeof node.isResolved !== 'boolean' || !object(node.comments) ||
            !Array.isArray(node.comments.nodes) || !node.comments.nodes.length) return [out, false];
        const first = node.comments.nodes[0];
        if (!object(first) || typeof first.body !== 'string' || !object(first.author) ||
            typeof first.author.login !== 'string') return [out, false];
        if (resolved !== null && node.isResolved !== resolved) continue;
        const record = this.own_thread_record(node, node.isResolved);
        if (record) {
          // An unusable own anchor is not evidence of a complete conversation.
          if (typeof record.thread_id !== 'string' || typeof record.comment_id !== 'number') return [out, false];
          if (resolved === null) record.resolved = node.isResolved;
          out.push(record);
        }
      }
      if (!threads.pageInfo.hasNextPage) return [out, true];
      const next = threads.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || seen.has(next)) return [out, false];
      seen.add(next);
      cursor = next;
    }
    return [out, false];
  }

  /**
   * A truncated traversal is not an empty list. `fetch_own_threads` reports whether the pages it
   * walked are all of them; dropping that boolean turned "I could not read the thread list" into
   * "there are no threads", which disables repeat suppression silently. Throwing lets `prepare`
   * record the reason, which is what its `.catch()` was always for.
   */
  async fetch_open_own_threads(pr: number): Promise<ThreadRecord[]> {
    const [threads, complete] = await this.fetch_own_threads(pr, false);
    if (!complete) throw new Error('open review threads could not be read in full');
    return threads;
  }

  async fetch_resolved_own_threads(pr: number): Promise<ThreadRecord[]> {
    const [threads, complete] = await this.fetch_own_threads(pr, true);
    if (!complete) throw new Error('resolved review threads could not be read in full');
    return threads;
  }

  /** Single traversal, so reopened threads cannot fall between two queries. */
  async fetch_thread_state(pr: number): Promise<[ThreadRecord[], ThreadRecord[], boolean]> {
    const [threads, complete] = await this.fetch_own_threads(pr, null);
    return [threads.filter(t => !t.resolved), threads.filter(t => t.resolved), complete];
  }

}
