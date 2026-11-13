/**
 * `goby wake` — goby's observability API, in one command.
 *
 * It reads the history GitHub already keeps — the reviews the reviewer posted, the issues the
 * cleaners and the tide filed, and the workflow runs that produced them — and prints it as JSON.
 * Nothing is stored: the same window returns the same records, and the records are facts about
 * runs rather than answers about them, so what to draw is the consumer's decision.
 *
 *   wake --repo owner/name --days 30 [--limit N] [--pretty]
 *
 * Inputs come from flags or from the environment the workflow already sets, so a step can be one
 * line: `run: /opt/wake/wake.js`.
 */
import { GitHubClient } from '../platforms/github.ts';
import { collect, type Window } from './collect.ts';
import { HINTS } from './records.ts';
import { gobyVersion } from './version.ts';

interface Options {
  repo: string;
  days: number;
  limit: number;
  pretty: boolean;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

/** A count, or the default. A limit of zero would read as "no data" rather than "no cap". */
function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function options(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  const repo = flag(argv, 'repo') ?? env.GITHUB_REPOSITORY ?? '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error('no repository: pass --repo owner/name, or set GITHUB_REPOSITORY');
  }
  return {
    repo,
    days: positive(flag(argv, 'days') ?? env.GOBY_WAKE_DAYS, 30),
    limit: positive(flag(argv, 'limit') ?? env.GOBY_WAKE_LIMIT, 500),
    pretty: argv.includes('--pretty'),
  };
}

/**
 * The window, as two strings rather than three days.
 *
 * `days: 30` starting at midnight UTC is deliberate: a run at 07:00 and a run at 23:00 must select
 * the same set of days, or two consumers comparing the same week get different numbers.
 */
function windowFor(days: number, now = Date.now()): Window {
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(),
    new Date(now).getUTCDate());
  const start = midnight - (days - 1) * 86_400_000;
  return { since: new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'), days };
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const opts = options(argv, env);
  const token = env.GITHUB_TOKEN ?? '';
  if (!token) throw new Error('GITHUB_TOKEN is required: it is the only credential this reads with');
  const window = windowFor(opts.days);
  const client = new GitHubClient(opts.repo, token);
  const collected = await collect(client, window, opts.limit);
  const body = {
    schema: 1,
    product: 'wake',
    // The version that produced *this* output, so a view built on it can say which goby drew it.
    v: gobyVersion(),
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    repo: opts.repo,
    window,
    counts: {
      reviews: collected.reviews.length,
      findings: collected.reviews.reduce((total, review) => total + review.findings.length, 0),
      issues: collected.issues.length,
      runs: collected.runs.length,
    },
    reviews: collected.reviews,
    issues: collected.issues,
    runs: collected.runs,
    hints: HINTS,
    // An empty list means the window is the whole window. Anything the read could not see is here,
    // because a graph built over a silently partial list is worse than no graph.
    notes: collected.notes,
  };
  process.stdout.write(JSON.stringify(body, null, opts.pretty ? 2 : 0) + '\n');
  return 0;
}
