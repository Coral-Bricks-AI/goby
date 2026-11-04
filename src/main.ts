/**
 * The action's entrypoint: one job, one mode, no argument parsing.
 *
 * Everything it needs arrives in the environment, because the only caller is `action.yml`
 * (a human running a review locally uses `scripts/replay.ts`). `mode` is `review` or `gate`;
 * the gate is what branch protection requires, the review is telemetry.
 */
import { review, repoFromRemote } from './core/review.ts';
import { refreshGate } from './core/gate.ts';
import { validSha } from './core/verdict.ts';
import { GitHubClient } from './platforms/github.ts';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function positiveInt(name: string, fallback?: number): number {
  const raw = env(name);
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  // digits only: `12;true` must not reach a shell, a URL, or a git ref.
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a positive integer`);
  return n;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

async function main(): Promise<number> {
  const mode = env('INPUT_MODE') ?? 'review';
  if (mode !== 'review' && mode !== 'gate') throw new Error('mode must be review or gate');
  const pr = positiveInt('INPUT_PR');
  const repo = env('GITHUB_REPOSITORY') ?? repoFromRemote();
  const token = env('GITHUB_TOKEN');
  const head = env('INPUT_HEAD');
  if (head !== undefined && !validSha(head)) throw new Error('expected-head must be a full commit SHA');
  if (!repo || !token) throw new Error(`${mode} requires a repository and a GitHub token`);

  if (mode === 'gate') {
    // No model, no key, no writes: recheck the evidence that is already on the PR.
    const result = await refreshGate(new GitHubClient(repo, token), pr, { expected_head: head, dry_run: false });
    console.log(JSON.stringify(result));
    return result.state === 'success' ? 0 : result.state === 'error' ? 1 : 2;
  }

  const result = await review({
    pr, repo, token, expected_head: head, agent: true, dry_run: false,
    fail_on_blocked: boolean('INPUT_FAIL', true),
    provider: env('GOBY_PROVIDER'), model: env('INPUT_MODEL'), base_url: env('INPUT_BASE_URL'),
    max_tool_turns: positiveInt('GOBY_MAX_TOOL_TURNS', 25),
    agent_wall_timeout: positiveInt('GOBY_WALL_TIMEOUT', 1200),
  });
  console.log(JSON.stringify(result.report, null, 2));
  if (result.gate) console.log(JSON.stringify({ gate: result.gate }));
  return result.exitCode;
}

main().then(code => { process.exitCode = code; },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
