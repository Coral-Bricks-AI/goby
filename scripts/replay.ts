/**
 * Historical replay: review a saved diff at a pinned commit and print the report.
 *
 *   bun run scripts/replay.ts --diff change.diff --repo owner/name --head-sha <sha> \
 *       [--pr-hint N] [--model M] [--max-tool-turns N] [--max-diff-lines N] [--no-agent] [--out FILE]
 *
 * This is how a reviewer is compared against a labelled PR corpus: the diff and the commit are
 * fixed, so two harnesses see the same code. `--head-sha` with a token enables the tools (they
 * read that commit through the API); without one they are disabled and only the local checkout
 * is available, which is reported in the output. Nothing is posted.
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { review, type ReviewOptions } from '../src/core/review.ts';

function int(value: string | boolean | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      diff: { type: 'string' }, repo: { type: 'string' }, 'head-sha': { type: 'string' },
      'pr-hint': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
      'base-url': { type: 'string' }, 'max-tool-turns': { type: 'string' },
      'wall-timeout': { type: 'string' }, 'max-diff-lines': { type: 'string' },
      'max-findings': { type: 'string' }, 'no-agent': { type: 'boolean' },
      token: { type: 'string' }, out: { type: 'string' },
    },
  });
  if (!values.diff) throw new Error('--diff is required (a saved unified diff)');
  if (values['head-sha'] && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(String(values['head-sha']))) {
    throw new Error('--head-sha must be a full commit SHA');
  }
  const options: ReviewOptions = {
    diff_file: resolve(String(values.diff)),
    repo: values.repo as string | undefined,
    head_sha: values['head-sha'] as string | undefined,
    pr_hint: values['pr-hint'] === undefined ? undefined : int(values['pr-hint'], 0, '--pr-hint'),
    token: (values.token as string | undefined) ?? process.env.GITHUB_TOKEN,
    dry_run: true,
    agent: !values['no-agent'],
    provider: values.provider as string | undefined,
    model: values.model as string | undefined,
    base_url: values['base-url'] as string | undefined,
    max_tool_turns: int(values['max-tool-turns'], 25, '--max-tool-turns'),
    agent_wall_timeout: int(values['wall-timeout'], 1200, '--wall-timeout'),
    max_diff_lines: int(values['max-diff-lines'], 10000, '--max-diff-lines'),
    max_findings: int(values['max-findings'], 30, '--max-findings'),
  };
  const result = await review(options, { warn: message => console.error(message) });
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (values.out) await writeFile(resolve(String(values.out)), text + '\n');
  return result.report && 'skipped' in result.report ? 0 : 0;
}

main().then(code => { process.exitCode = code; },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
