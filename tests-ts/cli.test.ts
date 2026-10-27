import {test, expect} from 'bun:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {workflowTemplate} from '../src/cli.ts';

const root = resolve(import.meta.dir, '..');
const binary = join(root, 'dist/cli.js');
const cleanEnv = {...process.env, GOBY_API_KEY: '', CORALBRICKS_API_KEY: '', OPENAI_API_KEY: '', GITHUB_TOKEN: ''};
function node(args: string[], cwd = root) { return spawnSync('node', [binary, ...args], {cwd, env: cleanEnv, encoding: 'utf8'}); }

test('bundle runs as a Node CLI without Python', () => {
  expect(node(['version']).stdout.trim()).toBe('0.2.0-dev.0');
  const h = node(['--help']); expect(h.status).toBe(0); expect(h.stdout).toContain('goby gate');
  for (const command of ['review', 'gate', 'init', 'doctor']) expect(node([command, '--help']).status).toBe(0);
  expect(node(['nonsense']).status).toBe(1);
});
test('init requires a full immutable pin and does not overwrite', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'goby-init-'));
  try {
    expect(node(['init'], cwd).status).toBe(1);
    expect(node(['init', '--ref', 'v1'], cwd).status).toBe(1);
    const sha = 'a'.repeat(40);
    expect(node(['init', '--ref', sha], cwd).status).toBe(0);
    const text = readFileSync(join(cwd, '.github/workflows/goby-review.yml'), 'utf8');
    expect(text).toContain('Coral-Bricks-AI/goby@' + sha);
    expect(text).toContain('cancel-in-progress: true');
    expect(text).toContain('ready_for_review, edited');
    expect(text).toContain('head.repo.full_name == github.repository');
    expect(node(['init', '--ref', sha], cwd).status).toBe(1);
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});
test('invalid CLI options fail before any network', () => {
  for (const args of [['gate'], ['review', '--max-tool-turns', 'NaN'], ['gate', '--pr', '1;echo'],
    ['gate', '--pr', '1', '--expected-head', 'short']]) expect(node(args).status).toBe(1);
  expect(workflowTemplate('a'.repeat(40), 'openai')).toContain('OPENAI_API_KEY');
});
test('local oversized dry-run needs neither GitHub nor model credentials', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'goby-local-'));
  try {
    const diff = join(cwd, 'change.diff'); writeFileSync(diff, 'one\ntwo\n');
    const run = node(['review', '--diff-file', diff, '--dry-run', '--max-diff-lines', '1'], cwd);
    expect(run.status).toBe(0); expect(run.stdout).toContain('Skipped:');
    expect(run.stdout).toContain('"phase": "skipped"');
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});
test('action executes only the trusted bundle with quoted data arguments', () => {
  const action = readFileSync(join(root, 'action.yml'), 'utf8');
  expect(action).not.toContain('setup-python');
  expect(action).toContain('bun install --frozen-lockfile --ignore-scripts');
  expect(action).not.toContain('actions/checkout');
  const last = action.slice(action.lastIndexOf('      run: |\n') + '      run: |\n'.length);
  const script = last.split('\n').map(line => line.startsWith('        ') ? line.slice(8) : line).join('\n');
  const cwd = mkdtempSync(join(tmpdir(), 'goby-action-'));
  try {
    const shim = join(cwd, 'node');
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGS_FILE"\n'); chmodSync(shim, 0o755);
    const dangerous = '$(touch PWNED); spaced model';
    const env = {...cleanEnv, PATH: cwd + ':' + process.env.PATH, ACTION_PATH: root, INPUT_PR: '12', INPUT_HEAD: 'a'.repeat(40),
      INPUT_MODE: 'review', INPUT_FAIL: 'true', INPUT_MODEL: dangerous, INPUT_BASE_URL: '', GOBY_PROVIDER: 'coral', ARGS_FILE: join(cwd, 'args')};
    const result = spawnSync('bash', ['-c', script], {cwd, env, encoding: 'utf8'});
    expect(result.status).toBe(0);
    const args = readFileSync(join(cwd, 'args'), 'utf8');
    expect(args).toContain(join(root, 'dist/cli.js'));
    expect(args.split('\n')).toContain(dangerous);
    expect(args).toContain('--fail-on-blocked');
    expect(spawnSync('test', ['-e', join(cwd, 'PWNED')]).status).toBe(1);
    for (const bad of [{INPUT_PR: '12;true'}, {INPUT_MODE: 'version'}, {INPUT_FAIL: 'maybe'}]) {
      expect(spawnSync('bash', ['-c', script], {cwd, env: {...env, ...bad}}).status).toBe(2);
    }
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});
