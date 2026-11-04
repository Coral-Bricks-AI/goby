/**
 * Refresh the gate for a PR without a model call: recheck the evidence already on it.
 *
 *   bun run scripts/gate.ts --pr 123 [--repo owner/name] [--expected-head <sha>] [--out FILE]
 *
 * This is the same code path the action runs in `mode: gate`, for local use and for a
 * workflow_run handoff. It never posts a review and never needs a model key.
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { refreshGate } from '../src/core/gate.ts';
import { validSha } from '../src/core/verdict.ts';
import { GitHubClient } from '../src/platforms/github.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: 'string' }, repo: { type: 'string' }, token: { type: 'string' },
      'expected-head': { type: 'string' }, 'dry-run': { type: 'boolean' }, out: { type: 'string' },
    },
  });
  const pr = Number(values.pr);
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('--pr must be a positive integer');
  const repo = (values.repo as string | undefined) ?? process.env.GITHUB_REPOSITORY;
  const token = (values.token as string | undefined) ?? process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('--repo and --token (or GITHUB_REPOSITORY and GITHUB_TOKEN) are required');
  const head = values['expected-head'] as string | undefined;
  if (head !== undefined && !validSha(head)) throw new Error('--expected-head must be a full commit SHA');

  const result = await refreshGate(new GitHubClient(repo, token), pr, {
    expected_head: head, dry_run: Boolean(values['dry-run']),
  });
  const text = JSON.stringify(result);
  console.log(text);
  if (values.out) await writeFile(resolve(String(values.out)), text + '\n');
  return result.state === 'success' ? 0 : result.state === 'error' ? 1 : 2;
}

main().then(code => { process.exitCode = code; },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
