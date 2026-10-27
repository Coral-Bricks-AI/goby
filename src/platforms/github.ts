import { BOT_LOGINS, MARKER, SUMMARY_PREFIX } from '../identity.ts';

const API = 'https://api.github.com';
export const CONTEXT_PATHS = ['CLAUDE.md', 'AGENTS.md'] as const;
const CONTEXT_MAX_CHARS = 20_000;
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
  resolution?: string;
  resolved?: boolean;
};

export interface SummaryRecord {
  node_id: string;
  sha: string;
  minimized: boolean;
  agent?: boolean;
}

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

  async fetch_pr_meta(pr: number): Promise<{ head_sha: string; head_ref: string; base_ref: string }> {
    const data = JSON.parse(await this.get(`/repos/${this.repo}/pulls/${pr}`));
    if (typeof data?.head?.sha !== 'string' || typeof data?.head?.ref !== 'string' || typeof data?.base?.ref !== 'string') {
      throw new GitHubError(200, `/repos/${this.repo}/pulls/${pr}`, 'Missing PR head metadata');
    }
    return { head_sha: data.head.sha, head_ref: data.head.ref, base_ref: data.base.ref };
  }

  async fetch_pr_intent(pr: number): Promise<{ title: string; body: string }> {
    const data = JSON.parse(await this.get(`/repos/${this.repo}/pulls/${pr}`));
    return { title: text(data.title), body: text(data.body) };
  }

  async fetch_diff(pr: number): Promise<string> {
    return this.get(`/repos/${this.repo}/pulls/${pr}`, 'application/vnd.github.v3.diff');
  }

  private contents_path(ref: string, path: string): string {
    return `/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  }

  async fetch_file(ref: string, path: string): Promise<string | null> {
    let data: JsonObject;
    try {
      data = JSON.parse(await this.get(this.contents_path(ref, path)));
    } catch (error) {
      if (error instanceof GitHubError && error.code === 404) return null;
      throw error;
    }
    if (typeof data?.content !== 'string') {
      if (Number.isInteger(data?.size)) {
        console.error(`note: ${path} at ${ref} is ${data.size} bytes (>1MB); skipping as context`);
      }
      return null;
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  async fetch_dir_listing(ref: string, path: string): Promise<{ name: string; type: string }[] | null> {
    let data: unknown;
    try {
      data = JSON.parse(await this.get(this.contents_path(ref, path)));
    } catch (error) {
      if (error instanceof GitHubError && error.code === 404) return null;
      throw error;
    }
    if (!Array.isArray(data)) return null;
    return data.filter(object).map(e => ({ name: text(e.name), type: text(e.type) }));
  }

  async fetch_tree_paths(ref: string): Promise<[string[], boolean]> {
    const data = JSON.parse(await this.get(`/repos/${this.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`));
    const paths: string[] = (data.tree ?? []).filter((e: unknown) => object(e) && e.type === 'blob')
      .map((e: JsonObject) => e.path);
    return [paths.sort(), Boolean(data.truncated)];
  }

  async fetch_path_history(path: string, at_ref: string, limit = 10): Promise<{ sha: string; date: string; message: string }[]> {
    const query = new URLSearchParams({ path, sha: at_ref, per_page: String(limit) });
    const data = JSON.parse(await this.get(`/repos/${this.repo}/commits?${query}`));
    if (!Array.isArray(data)) return [];
    return data.filter(object).map(c => ({
      sha: text(c.sha), date: text(c.commit?.author?.date), message: text(c.commit?.message),
    }));
  }

  async fetch_repo_context(head: string): Promise<string> {
    const chunks: string[] = [];
    for (const path of CONTEXT_PATHS) {
      const body = await this.fetch_file(head, path);
      if (body) chunks.push(`### ${path}\n\n${cut(body, CONTEXT_MAX_CHARS)}`);
    }
    return chunks.join('\n\n');
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

  /** Legacy reviewed-head guard; gate receipt validation belongs to the caller. */
  async head_already_reviewed(pr: number, head: string, require_agent = false): Promise<boolean> {
    const marker = `head=${head.slice(0, 10)}`;
    for (let page = 1; page <= 20; page++) {
      const reviews = JSON.parse(await this.get(`/repos/${this.repo}/pulls/${pr}/reviews?per_page=100&page=${page}`));
      for (const review of reviews) {
        if (!object(review) || !this.bot_logins.has(review.user?.login)) continue;
        const body = text(review.body);
        if (!(body.includes(`${marker} -->`) || body.includes(`${marker} v=`) || review.commit_id === head)) continue;
        if (!require_agent || body.startsWith(`${SUMMARY_PREFIX} — agentic review`)) return true;
      }
      if (reviews.length < 100) return false;
    }
    return false;
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

  async fetch_open_own_threads(pr: number): Promise<ThreadRecord[]> {
    return (await this.fetch_own_threads(pr, false))[0];
  }

  async fetch_resolved_own_threads(pr: number): Promise<ThreadRecord[]> {
    return (await this.fetch_own_threads(pr, true))[0];
  }

  /** Single traversal, so reopened threads cannot fall between two queries. */
  async fetch_thread_state(pr: number): Promise<[ThreadRecord[], ThreadRecord[], boolean]> {
    const [threads, complete] = await this.fetch_own_threads(pr, null);
    return [threads.filter(t => !t.resolved), threads.filter(t => t.resolved), complete];
  }

  async fetch_own_summaries(pr: number): Promise<[SummaryRecord[], boolean]> {
    const [owner, ...parts] = this.repo.split('/');
    const out: SummaryRecord[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const data = await this.graphql(SUMMARY_QUERY, { owner, name: parts.join('/'), n: pr, cursor });
      const reviews = data?.data?.repository?.pullRequest?.reviews;
      // Also fail closed for missing/malformed summary pages; a missing page
      // is not a complete empty list, even if GraphQL returned HTTP 200.
      if (!object(reviews) || !Array.isArray(reviews.nodes) || !object(reviews.pageInfo) ||
          typeof reviews.pageInfo.hasNextPage !== 'boolean') return [out, false];
      for (const node of reviews.nodes) {
        if (!object(node) || !object(node.author) || typeof node.author.login !== 'string') return [out, false];
        if (!this.bot_logins.has(node.author.login)) continue;
        if (typeof node.id !== 'string' || typeof node.body !== 'string' || typeof node.isMinimized !== 'boolean') return [out, false];
        out.push({
          node_id: node.id, sha: node.body.match(new RegExp(`<!-- ${MARKER} head=(\\w+)`))?.[1] ?? '',
          minimized: node.isMinimized, agent: node.body.startsWith(`${SUMMARY_PREFIX} — agentic review`),
        });
      }
      if (!reviews.pageInfo.hasNextPage) return [out, true];
      const next = reviews.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || seen.has(next)) return [out, false];
      seen.add(next);
      cursor = next;
    }
    return [out, false];
  }

  async minimize_comment(id: string): Promise<boolean> {
    const data = await this.graphql(`mutation($id: ID!) {
      minimizeComment(input: {subjectId: $id, classifier: RESOLVED}) {
        minimizedComment { isMinimized }
      }
    }`, { id });
    return Boolean(data?.data?.minimizeComment?.minimizedComment?.isMinimized);
  }
}

/** Use only after both summary and thread traversals reported complete. */
export function summaries_to_minimize<T extends SummaryRecord>(
  summaries: T[], open_threads: { sha?: string }[], resolved_threads: { sha?: string }[],
): T[] {
  const open = new Set(open_threads.map(t => t.sha).filter(Boolean));
  const raised = new Set([...open, ...resolved_threads.map(t => t.sha).filter(Boolean)]);
  return summaries.filter(s => !s.minimized && s.sha && !s.agent && raised.has(s.sha) && !open.has(s.sha));
}
