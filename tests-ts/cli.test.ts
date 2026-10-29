import {test, expect} from 'bun:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {workflowTemplate, pin_rewrite, resolve_ref} from '../src/cli.ts';

const root = resolve(import.meta.dir, '..');
const binary = join(root, 'dist/cli.js');
const cleanEnv = {...process.env, GOBY_API_KEY: '', CORALBRICKS_API_KEY: '', OPENAI_API_KEY: '', GITHUB_TOKEN: ''};
function node(args: string[], cwd = root) { return spawnSync('node', [binary, ...args], {cwd, env: cleanEnv, encoding: 'utf8'}); }

test('bundle runs as a Node CLI without Python', () => {
  expect(node(['version']).stdout.trim()).toBe('0.3.0');
  const h = node(['--help']); expect(h.status).toBe(0); expect(h.stdout).toContain('goby gate');
  for (const command of ['review', 'gate', 'init', 'pin', 'doctor']) expect(node([command, '--help']).status).toBe(0);
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
test('pin moves a full-SHA pin and leaves tags and prose alone', async () => {
  const old = 'b'.repeat(40), next = 'c'.repeat(40);
  const workflow = `      - uses: Coral-Bricks-AI/goby@${old}\n# see Coral-Bricks-AI/goby@${old} in the docs\n      - uses: Coral-Bricks-AI/goby@v0.3.0\n`;
  const single = pin_rewrite(workflow.replace(`@${old}\n# see`, '@v0.3.0\n# see'), next);
  expect(single.occurrences).toBe(1);
  expect(single.previous).toEqual([old]);
  expect(single.updated).toContain(`Coral-Bricks-AI/goby@${next}`);
  const both = pin_rewrite(workflow, next);
  expect(both.occurrences).toBe(2);
  expect(both.updated).not.toContain(old);
  expect(both.updated).toContain('Coral-Bricks-AI/goby@v0.3.0'); // tag pins are not rewritten
  expect(pin_rewrite(both.updated, next).occurrences).toBe(2); // idempotent
  expect(pin_rewrite(both.updated, next).updated).toBe(both.updated);
  expect(pin_rewrite('uses: Coral-Bricks-AI/goby@main', next).occurrences).toBe(0);
  // A ref that is neither a full SHA nor a release tag is rejected before any network.
  for (const bad of ['main', 'v1', 'v0.1', 'HEAD', 'a'.repeat(39)]) await expect(resolve_ref(bad, 'Coral-Bricks-AI/goby', undefined)).rejects.toThrow();
  expect(await resolve_ref(old, 'Coral-Bricks-AI/goby', undefined)).toBe(old);
});
test('pin CLI rewrites only the pinned workflow file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'goby-pin-'));
  try {
    const file = join(cwd, 'goby-review.yml');
    const old = 'b'.repeat(40), next = 'd'.repeat(40);
    writeFileSync(file, `jobs:\n  review:\n    steps:\n      - uses: Coral-Bricks-AI/goby@${old}\n`);
    expect(node(['pin'], cwd).status).toBe(1); // no --ref
    const dry = node(['pin', '--ref', next, '--file', file, '--dry-run'], cwd);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({pinned: next, previous: [old], occurrences: 1, changed: true, dry_run: true});
    expect(readFileSync(file, 'utf8')).toContain(old); // dry run writes nothing
    expect(node(['pin', '--ref', next, '--file', file], cwd).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain(`Coral-Bricks-AI/goby@${next}`);
    expect(node(['pin', '--ref', next], cwd).status).toBe(1); // no workflow at the default path
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
