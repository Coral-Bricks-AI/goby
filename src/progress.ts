// A "review in progress" note on the pull request: posted when a review starts, deleted when it
// ends. Purely cosmetic, so it is built to be unable to affect a review:
//   - it imports nothing from the rest of goby, and nothing imports it;
//   - it is its own bundle (`progress.js`), run by the entrypoint with a wall clock and `|| true`;
//   - every error is logged and swallowed, and the process always exits 0;
//   - it writes only a PR conversation comment (an "issue comment" in GitHub's API), a kind the
//     review never reads, under its own marker, so it cannot be mistaken for a review or a thread.

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const PREFIX = '<!-- goby-progress';

// Plain strings, not String.raw: bun's transpiler escapes non-ASCII inside a raw template, so the
// comment would show `\u00B0` instead of the degree sign.
const ART = [
  '        o    °',
  '     °     .',
  '   ><((((°>    . o O',
].join('\n') + '\n';

export type Comment = { id: number; body?: string | null; user?: { type?: string } | null };

export type Options = { repo: string; pr: string; token: string; run: string; fetch?: typeof fetch };

/** The marker names the run, so a cancelled run's late cleanup cannot delete its successor's note. */
export function marker(run: string): string {
  return `${PREFIX} run=${run} -->`;
}

export function body(run: string): string {
  return `${marker(run)}\n\`\`\`text\n${ART}\`\`\`\n\n` +
    '**Goby is reviewing this change.** This note goes away when the review is posted.';
}

/** Ours means: posted by a bot, and the body leads with the progress marker (of `run`, if given). */
export function is_ours(comment: Comment, run?: string): boolean {
  if (comment.user?.type !== 'Bot') return false;
  const text = comment.body ?? '';
  return run === undefined ? text.startsWith(PREFIX) : text.startsWith(marker(run));
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

async function list(opts: Options): Promise<Comment[]> {
  const all: Comment[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await (await call(opts, 'GET',
      `/repos/${opts.repo}/issues/${opts.pr}/comments?per_page=100&page=${page}`)).json() as Comment[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Deletes our notes: every run's when `run` is omitted (a cancelled run may have left one). */
export async function clear(opts: Options, run?: string): Promise<number> {
  const ours = (await list(opts)).filter(c => is_ours(c, run));
  for (const c of ours) await call(opts, 'DELETE', `/repos/${opts.repo}/issues/comments/${c.id}`);
  return ours.length;
}

export async function start(opts: Options): Promise<void> {
  await clear(opts);
  await call(opts, 'POST', `/repos/${opts.repo}/issues/${opts.pr}/comments`, { body: body(opts.run) });
}

export async function stop(opts: Options): Promise<void> {
  await clear(opts, opts.run);
}

/** Never throws, never fails: the review's outcome must not depend on this note. */
export async function main(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const mode = argv[0];
  const opts = {
    repo: env.GOBY_REPO ?? '', pr: env.GOBY_PR ?? '', token: env.GITHUB_TOKEN ?? '',
    run: [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].filter(Boolean).join('.') || (env.GOBY_HEAD ?? '').slice(0, 10),
  };
  if ((mode !== 'start' && mode !== 'stop') || !opts.repo || !opts.pr || !opts.token || !opts.run) {
    console.error(`progress: skipped (${mode ?? 'no mode'}; missing input)`);
    return;
  }
  try {
    await (mode === 'start' ? start(opts) : stop(opts));
  } catch (error) {
    console.error(`progress: ${mode} failed, ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
