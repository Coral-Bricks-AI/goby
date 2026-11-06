// A "review in progress" note on the pull request. One note per pull request, edited in place: a
// review's start turns it to "reviewing" (posting it the first time), its end turns it to "done".
// Editing rather than deleting means one notification per pull request instead of one per push,
// and an open page never shows a note that no longer exists.
//
// Purely cosmetic, so it is built to be unable to affect a review:
//   - it imports nothing from the rest of goby, and nothing imports it;
//   - it is its own bundle (`progress.js`), run by the entrypoint with a wall clock and `|| true`;
//   - every error is logged and swallowed, and the process always exits 0;
//   - it writes only a PR conversation comment (an "issue comment" in GitHub's API), a kind the
//     review never reads, under its own marker, so it cannot be mistaken for a review or a thread.

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const PREFIX = '<!-- goby-progress';

// The pictures live in goby's own public repository, at `main`: a merged change to an SVG reaches
// every note, existing ones included, with no code change or image rebuild. GitHub proxies the image
// and plays an SVG's own animation, but runs no script and loads nothing else it references.
const ASSETS = 'https://raw.githubusercontent.com/Coral-Bricks-AI/goby/main/review/assets';

const picture = (state: State): string =>
  `<img src="${ASSETS}/${state}.svg" alt="${state === 'done' ? 'Goby is done' : 'Goby is reviewing'}" width="400">`;

export type Comment = { id: number; body?: string | null; user?: { type?: string } | null };

export type Options = { repo: string; pr: string; token: string; run: string; head: string; fetch?: typeof fetch };

export type State = 'reviewing' | 'done';

/** The marker names the run, so a cancelled run's late `stop` cannot overwrite its successor's note. */
export function marker(run: string, state: State): string {
  return `${PREFIX} run=${run} state=${state} -->`;
}

export function body(run: string, state: State, head: string): string {
  const sha = `\`${head.slice(0, 10)}\``;
  // "done" is also reached when the reviewer failed: no review is posted then, and the check says why.
  const text = state === 'done'
    ? `**Goby is done with ${sha}.** Its review is further down; if there is none, the Goby Review check says why.`
    : `**Goby is reviewing ${sha}.** This note updates when the review is posted.`;
  return `${marker(run, state)}\n${picture(state)}\n\n${text}`;
}

/** Ours means: posted by a bot, and the body leads with the progress marker (of `run`, if given). */
export function is_ours(comment: Comment, run?: string): boolean {
  if (comment.user?.type !== 'Bot') return false;
  const text = comment.body ?? '';
  return text.startsWith(run === undefined ? PREFIX : `${PREFIX} run=${run} `);
}

async function call(opts: Options, method: string, path: string, payload?: unknown): Promise<Response> {
  const response = await (opts.fetch ?? fetch)(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${opts.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response;
}

async function ours(opts: Options): Promise<Comment[]> {
  const all: Comment[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await (await call(opts, 'GET',
      `/repos/${opts.repo}/issues/${opts.pr}/comments?per_page=100&page=${page}`)).json() as Comment[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.filter(c => is_ours(c));
}

const edit = (opts: Options, id: number, text: string) =>
  call(opts, 'PATCH', `/repos/${opts.repo}/issues/comments/${id}`, { body: text });

/**
 * Edits the oldest note to "reviewing", or posts one if there is none. Any other note (two runs that
 * both found none and both posted) is deleted, so the pull request converges on one.
 */
export async function start(opts: Options): Promise<void> {
  const [keep, ...extra] = await ours(opts);
  const text = body(opts.run, 'reviewing', opts.head);
  if (keep) await edit(opts, keep.id, text);
  else await call(opts, 'POST', `/repos/${opts.repo}/issues/${opts.pr}/comments`, { body: text });
  for (const c of extra) await call(opts, 'DELETE', `/repos/${opts.repo}/issues/comments/${c.id}`);
}

/** Turns this run's note to "done"; a note a newer run has since claimed is left alone. */
export async function stop(opts: Options): Promise<void> {
  for (const c of (await ours(opts)).filter(c => is_ours(c, opts.run))) {
    await edit(opts, c.id, body(opts.run, 'done', opts.head));
  }
}

/** Never throws, never fails: the review's outcome must not depend on this note. */
export async function main(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const mode = argv[0];
  const opts = {
    repo: env.GOBY_REPO ?? '', pr: env.GOBY_PR ?? '', token: env.GITHUB_TOKEN ?? '',
    run: [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].filter(Boolean).join('.') || (env.GOBY_HEAD ?? '').slice(0, 10),
    head: env.GOBY_HEAD ?? '',
  };
  if ((mode !== 'start' && mode !== 'stop') || !opts.repo || !opts.pr || !opts.token || !opts.run || !opts.head) {
    console.error(`progress: skipped (${mode ?? 'no mode'}; missing input)`);
    return;
  }
  try {
    await (mode === 'start' ? start(opts) : stop(opts));
  } catch (error) {
    console.error(`progress: ${mode} failed, ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
