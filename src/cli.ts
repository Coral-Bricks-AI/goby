#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {mkdir, writeFile, access, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {review, repoFromRemote, readKeyFile, type ReviewOptions} from './core/review.ts';
import {refreshGate} from './core/gate.ts';
import {run_canary} from './core/canary.ts';
import {validSha} from './core/verdict.ts';
import {GitHubClient} from './platforms/github.ts';
import {resolve_provider} from './providers/index.ts';
import {REVIEW_VERSION} from './identity.ts';

const help = `goby — code review backed by kernel-checked policies

  goby review --pr NUMBER --agent --fail-on-blocked
  goby review --diff-file FILE --dry-run [--agent]
  goby gate --pr NUMBER [--expected-head SHA] [--dry-run]
  goby init [coral|openai] --ref TAG_OR_SHA
  goby pin --ref TAG_OR_SHA [--file PATH] [--dry-run]
  goby doctor [coral|openai] [--deep]
  goby version

Review options: --repo owner/name, --token TOKEN, --model MODEL,
--provider NAME, --base-url URL, --api-key-file FILE, --expected-head SHA,
--head-sha SHA, --pr-hint NUMBER, --max-tool-turns N, --agent-wall-timeout S,
--max-diff-lines N, --max-findings N, --timeout S, --force.
Gate options: --repo, --token, --expected-head, --dry-run, --output-file FILE.
Pin options: --ref TAG_OR_SHA (tags resolve to the commit they point at),
--file PATH (default .github/workflows/goby-review.yml), --repo owner/name
(default Coral-Bricks-AI/goby), --all, --dry-run.
`;
function numberOption(value: string | boolean | undefined, fallback: number, name: string, integer = true, allowZero = false): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n)) || n < (allowZero ? 0 : Number.MIN_VALUE)) throw new Error(`Invalid ${name}`);
  return n;
}
function optionalNumber(value: string | boolean | undefined, name: string): number | undefined {
  return value === undefined ? undefined : numberOption(value, 0, name);
}
export function workflowTemplate(ref: string, providerName: string): string {
  if (!validSha(ref)) throw new Error('--ref must be a full reviewed Goby commit SHA');
  const p = resolve_provider(providerName);
  return `# Trusted source only. Never check out or execute PR code in this job.
name: Goby review
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, edited]
permissions:
  contents: read
  pull-requests: write
  statuses: write
concurrency:
  group: goby-review-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: Coral-Bricks-AI/goby@${ref}
        with:
          provider: ${p.name}
          model: ${JSON.stringify(p.default_model ?? '')}
        env:
          ${p.api_key_env}: \${{ secrets.${p.api_key_env} }}
`;
}
export interface CLIIO {out?: (text: string) => void; error?: (text: string) => void}
const PIN_PATTERN = /Coral-Bricks-AI\/goby@([0-9a-f]{40}|[0-9a-f]{64})/g;
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Rewrite every full-SHA pin of this action; leave tags, branches and prose alone. */
export function pin_rewrite(text: string, sha: string): {updated: string; previous: string[]; occurrences: number} {
  const found = [...text.matchAll(PIN_PATTERN)];
  return {updated: text.replace(PIN_PATTERN, `Coral-Bricks-AI/goby@${sha}`),
    previous: [...new Set(found.map(m => m[1]!))], occurrences: found.length};
}

/** A release tag is a human handle; the workflow still pins the commit it names. */
export async function resolve_ref(ref: string, repo: string, token: string | undefined): Promise<string> {
  if (validSha(ref)) return ref;
  if (!RELEASE_TAG.test(ref)) throw new Error('--ref must be a full commit SHA or a release tag such as v0.3.0');
  const client = new GitHubClient(repo, token ?? '');
  const pointer = JSON.parse(await client.get(`/repos/${repo}/git/ref/tags/${encodeURIComponent(ref)}`)) as {object?: {type?: string; sha?: string}};
  let sha = pointer.object?.sha ?? '';
  if (pointer.object?.type === 'tag') {
    const tag = JSON.parse(await client.get(`/repos/${repo}/git/tags/${encodeURIComponent(sha)}`)) as {object?: {sha?: string}};
    sha = tag.object?.sha ?? '';
  }
  if (!validSha(sha)) throw new Error(`tag ${ref} in ${repo} does not name a commit`);
  return sha;
}
export async function main(argv: string[] = process.argv.slice(2), io: CLIIO = {}): Promise<number> {
  const out = io.out ?? console.log;
  const error = io.error ?? console.error;
  const [command, ...args] = argv;
  if (!command || ['help', '-h', '--help'].includes(command)) { out(help); return command ? 0 : 2; }
  if (['version', '--version', '-V'].includes(command)) { out(REVIEW_VERSION); return 0; }
  if (args.includes('--help') || args.includes('-h')) { out(help); return 0; }
  try {
    if (command === 'init') {
      const parsed = parseArgs({args, allowPositionals: true, options: {ref: {type: 'string'}, repo: {type: 'string'}, token: {type: 'string'}}});
      if (!parsed.values.ref) throw new Error('goby init requires --ref FULL_GOBY_COMMIT_SHA or a release tag');
      if (parsed.positionals.length > 1) throw new Error('Expected at most one provider name');
      const provider = resolve_provider(parsed.positionals[0]);
      // A tag is only a handle: the workflow still gets the immutable commit.
      const ref = await resolve_ref(parsed.values.ref, parsed.values.repo ?? 'Coral-Bricks-AI/goby', parsed.values.token ?? process.env.GITHUB_TOKEN);
      const target = resolve('.github/workflows/goby-review.yml');
      const text = workflowTemplate(ref, provider.name);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, text, {flag: 'wx'});
      out(`Wrote ${target} pinning Coral-Bricks-AI/goby@${ref}.\nAdd ${provider.api_key_env} as a repository secret. Require Goby Gate and CI, not Goby Review. See docs/merge-gate.md for a workflow_run handoff.`);
      return 0;
    }
    if (command === 'pin') {
      const parsed = parseArgs({args, options: {ref: {type: 'string'}, file: {type: 'string'}, repo: {type: 'string'},
        token: {type: 'string'}, all: {type: 'boolean'}, 'dry-run': {type: 'boolean'}}});
      if (!parsed.values.ref) throw new Error('goby pin requires --ref TAG_OR_SHA');
      const sourceRepo = parsed.values.repo ?? 'Coral-Bricks-AI/goby';
      const file = resolve(parsed.values.file ?? '.github/workflows/goby-review.yml');
      const sha = await resolve_ref(parsed.values.ref, sourceRepo, parsed.values.token ?? process.env.GITHUB_TOKEN);
      const text = await readFile(file, 'utf8');
      const {updated, previous, occurrences} = pin_rewrite(text, sha);
      if (!occurrences) throw new Error(`no Coral-Bricks-AI/goby@<full sha> pin in ${file}`);
      if (occurrences > 1 && !parsed.values.all) throw new Error(`${file} pins Goby ${occurrences} times; pass --all to update every pin`);
      out(JSON.stringify({file, repo: sourceRepo, ref: parsed.values.ref, pinned: sha, previous,
        occurrences, changed: updated !== text, dry_run: Boolean(parsed.values['dry-run'])}, null, 2));
      if (!parsed.values['dry-run'] && updated !== text) await writeFile(file, updated);
      return 0;
    }
    if (command === 'doctor') {
      const parsed = parseArgs({args, allowPositionals: true, options: {deep: {type: 'boolean'},
        model: {type: 'string'}, 'base-url': {type: 'string'}, 'api-key-file': {type: 'string'}, timeout: {type: 'string'}}});
      if (parsed.positionals.length > 1) throw new Error('Expected at most one provider name');
      const provider = resolve_provider(parsed.positionals[0]);
      let keySource = process.env.GOBY_API_KEY ? '$GOBY_API_KEY' : process.env[provider.api_key_env] ? `$${provider.api_key_env}` : 'missing';
      if (keySource === 'missing') { try { await access(resolve(homedir(), '.config/goby/api_key')); keySource = '~/.config/goby/api_key'; } catch {} }
      out(JSON.stringify({version: REVIEW_VERSION, provider: provider.name, endpoint: provider.base_url, model: process.env.GOBY_MODEL || provider.default_model,
        key_source: keySource, github_token: Boolean(process.env.GITHUB_TOKEN), responses_api: provider.supports_responses}, null, 2));
      if (!parsed.values.deep) return keySource === 'missing' ? 1 : 0;
      if (keySource === 'missing') throw new Error('--deep needs a key: set GOBY_API_KEY, the provider key, or --api-key-file');
      const key = process.env.GOBY_API_KEY || process.env[provider.api_key_env] || await readKeyFile(String(parsed.values['api-key-file'] ?? '~/.config/goby/api_key'));
      const canary = await run_canary({api_key: key,
        model: String(parsed.values.model ?? process.env.GOBY_MODEL ?? provider.default_model ?? ''),
        base_url: String(parsed.values['base-url'] ?? process.env.GOBY_BASE_URL ?? provider.base_url),
        timeout_s: numberOption(parsed.values.timeout, 120, '--timeout', false)});
      out(JSON.stringify({deep: canary}, null, 2));
      return canary.ok ? 0 : 1;
    }
    if (command !== 'review' && command !== 'gate') throw new Error(`Unknown command: ${command}`);
    const {values: v} = parseArgs({args, options: {
      pr: {type: 'string'}, repo: {type: 'string'}, token: {type: 'string'},
      'expected-head': {type: 'string'}, 'dry-run': {type: 'boolean'}, 'output-file': {type: 'string'},
      ...(command === 'review' ? {
        agent: {type: 'boolean' as const}, force: {type: 'boolean' as const}, 'fail-on-blocked': {type: 'boolean' as const},
        'diff-file': {type: 'string' as const}, 'head-sha': {type: 'string' as const}, 'pr-hint': {type: 'string' as const},
        provider: {type: 'string' as const}, model: {type: 'string' as const}, 'base-url': {type: 'string' as const}, 'api-key-file': {type: 'string' as const},
        'max-tool-turns': {type: 'string' as const}, 'agent-wall-timeout': {type: 'string' as const},
        'max-diff-lines': {type: 'string' as const}, 'max-findings': {type: 'string' as const}, timeout: {type: 'string' as const},
      } : {}),
    }});
    const pr = optionalNumber(v.pr, '--pr');
    const repo = v.repo as string | undefined ?? process.env.GITHUB_REPOSITORY ?? repoFromRemote();
    const token = v.token as string | undefined ?? process.env.GITHUB_TOKEN;
    const expected = v['expected-head'] as string | undefined;
    if (expected && !validSha(expected)) throw new Error('--expected-head must be a full commit SHA');
    if (command === 'gate') {
      if (!pr || !repo || !token) throw new Error('gate requires --pr, --repo and --token (or environment defaults)');
      const result = await refreshGate(new GitHubClient(repo, token), pr, {expected_head: expected, dry_run: Boolean(v['dry-run'])});
      const text = JSON.stringify(result);
      out(text);
      if (v['output-file']) await writeFile(String(v['output-file']), text + '\n');
      return result.state === 'success' ? 0 : result.state === 'error' ? 1 : 2;
    }
    const options: ReviewOptions = {
      pr, repo, token, expected_head: expected, dry_run: Boolean(v['dry-run']), agent: Boolean(v.agent), force: Boolean(v.force), fail_on_blocked: Boolean(v['fail-on-blocked']),
      diff_file: v['diff-file'] as string | undefined, head_sha: v['head-sha'] as string | undefined, pr_hint: optionalNumber(v['pr-hint'], '--pr-hint'),
      provider: v.provider as string | undefined, model: (v.model ?? process.env.GOBY_MODEL) as string | undefined,
      base_url: (v['base-url'] ?? process.env.GOBY_BASE_URL) as string | undefined, api_key_file: v['api-key-file'] as string | undefined,
      max_tool_turns: numberOption(v['max-tool-turns'] ?? process.env.GOBY_MAX_TOOL_TURNS, 10, '--max-tool-turns'),
      agent_wall_timeout: numberOption(v['agent-wall-timeout'] ?? process.env.GOBY_WALL_TIMEOUT, 600, '--agent-wall-timeout', false),
      max_diff_lines: numberOption(v['max-diff-lines'], 10000, '--max-diff-lines'), max_findings: numberOption(v['max-findings'], 30, '--max-findings', true, true),
      timeout: numberOption(v.timeout, 300, '--timeout', false),
    };
    if (options.head_sha && !validSha(options.head_sha)) throw new Error('--head-sha must be a full commit SHA');
    const result = await review(options, {warn: error});
    out(JSON.stringify(result.report, null, 2));
    if (result.gate) out(JSON.stringify({gate: result.gate}));
    if (result.summary && options.dry_run) out(`\n=== summary body (not posted) ===\n${result.summary}`);
    if (v['output-file']) await writeFile(String(v['output-file']), JSON.stringify(result) + '\n');
    return result.exitCode;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
