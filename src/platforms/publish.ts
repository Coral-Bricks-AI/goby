import type { Finding } from '../core/contract.ts';
import { GATE_CONTEXT, MARKER, REVIEW_VERSION, STATUS_CONTEXT } from '../identity.ts';
import { GitHubClient, GitHubError } from './github.ts';

const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join('');

export function comment_body(finding: Finding, head: string): string {
  const lines = [`**[${finding.severity}] ${finding.title}**`, ''];
  if (finding.detail) lines.push(finding.detail, '');
  let marker = `<!-- ${MARKER} id=${finding.fid} severity=${finding.severity} kind=bug sha=${head.slice(0, 10)}`;
  if (finding.end_line != null && finding.end_line > finding.line) {
    marker += ` start_line=${finding.line} end_line=${finding.end_line}`;
  }
  lines.push(`${marker} -->`);
  return lines.join('\n');
}

export function _comment_position(finding: Finding): {
  path: string; line: number; side: 'RIGHT'; start_line?: number; start_side?: 'RIGHT';
} {
  const pos: ReturnType<typeof _comment_position> = {
    path: finding.path, line: finding.end_line ?? finding.line, side: 'RIGHT',
  };
  if (finding.end_line != null && finding.end_line > finding.line) {
    pos.start_line = finding.line;
    pos.start_side = 'RIGHT';
  }
  return pos;
}

/** The caller owns dry-run and head freshness checks; this function always posts. */
export async function post_review(client: GitHubClient, pr: number, head: string, summary: string, findings: Finding[]) {
  const path = `/repos/${client.repo}/pulls/${pr}/reviews`;
  const payload = {
    commit_id: head,
    body: `${summary.trimEnd()}\n\n<!-- ${MARKER} head=${head.slice(0, 10)} v=${REVIEW_VERSION} -->`,
    event: 'COMMENT',
    comments: findings.map(f => ({ ..._comment_position(f), body: comment_body(f, head) })),
  };
  try {
    return await client.post(path, payload);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.code !== 422 || !payload.comments.length) throw error;
    const dropped = findings.map(f => `- \`${f.path}:${f.line}\` **[${f.severity}]** ${f.title} — ${cut(f.detail, 300)}`).join('\n');
    return client.post(path, {
      ...payload, comments: [],
      body: payload.body + '\n\n(Inline comment threads could not be posted: GitHub rejected a ' +
        'comment position. The findings, preserved:)\n\n' + dropped,
    });
  }
}

export async function reply_in_thread(client: GitHubClient, pr: number, id: number, body: string) {
  return client.post(`/repos/${client.repo}/pulls/${pr}/comments`, { body, in_reply_to: id });
}

export async function resolve_thread(client: GitHubClient, id: string) {
  return client.graphql('mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) ' +
    '{ thread { isResolved } } }', { t: id });
}

export async function post_gate_status(client: GitHubClient, sha: string, state: string, description: string) {
  if (!['pending', 'success', 'failure', 'error'].includes(state)) throw new Error(`Invalid gate state: ${state}`);
  return client.post(`/repos/${client.repo}/statuses/${sha}`, {
    state, context: GATE_CONTEXT, description: cut(description, 140),
  });
}

/** Execution telemetry, not merge eligibility. Kept separate from Goby Gate. */
export async function post_status(client: GitHubClient, sha: string, state: string, description: string, target_url?: string | null) {
  return client.post(`/repos/${client.repo}/statuses/${sha}`, {
    state, context: STATUS_CONTEXT, description: cut(description, 140),
    ...(target_url ? { target_url } : {}),
  });
}
