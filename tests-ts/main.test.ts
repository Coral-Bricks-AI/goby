import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dir, '..');
const binary = join(root, 'dist/main.js');
const cleanEnv = {...process.env, GOBY_API_KEY: '', CORALBRICKS_API_KEY: '', OPENAI_API_KEY: '', GITHUB_TOKEN: ''};
function node(args: string[], env: Record<string, string | undefined> = {}, cwd = root) {
  return spawnSync('node', [binary, ...args], {cwd, env: {...cleanEnv, ...env}, encoding: 'utf8'});
}

test('the entrypoint reads the environment and nothing else', () => {
  // No help, no version, no subcommands: the only caller is action.yml.
  expect(node(['version']).status).toBe(1);
  expect(node(['--help']).status).toBe(1);
  for (const command of ['review', 'gate', 'doctor', 'init', 'pin']) {
    expect(node([command]).status).toBe(1);
  }
});

test('bad input fails before any network call', () => {
  for (const env of [
    {},                                                                     // no PR at all
    {INPUT_PR: '12;true'},                                                  // not an integer
    {INPUT_PR: '0'},                                                        // must be positive
    {INPUT_PR: '12', INPUT_MODE: 'version'},                                // only review|gate
    {INPUT_PR: '12', INPUT_HEAD: 'short'},                                  // not a full SHA
    {INPUT_PR: '12', INPUT_FAIL: 'maybe'},                                  // only true|false
    {INPUT_PR: '12', GITHUB_TOKEN: '', GITHUB_REPOSITORY: 'acme/widgets'},  // nothing to authenticate with
  ]) {
    const run = node([], env);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
  }
});

test('gate mode never asks for a model key', () => {
  // The gate rechecks evidence already on the PR, so a missing key must not be why it fails.
  const run = node([], {INPUT_MODE: 'gate', INPUT_PR: '12', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/widgets'});
  expect(run.status).toBe(1); // no network here: it errors, but not on the key
  expect(run.stderr.toLowerCase()).not.toContain('api key');
});

test('the action runs the built entrypoint and passes inputs as environment', () => {
  const action = readFileSync(join(root, 'action.yml'), 'utf8');
  expect(action).not.toContain('setup-python');
  expect(action).not.toContain('actions/checkout');
  expect(action).toContain('bun install --frozen-lockfile --ignore-scripts');
  expect(action).toContain('node "$ACTION_PATH/dist/main.js"');
  // Nothing from the caller is interpolated into a shell command.
  const runBlock = action.slice(action.lastIndexOf('      run: '));
  expect(runBlock).not.toContain('${{ inputs.');
  for (const name of ['INPUT_PR', 'INPUT_HEAD', 'INPUT_MODE', 'INPUT_FAIL', 'GOBY_PROVIDER']) {
    expect(action).toContain(`${name}:`);
  }
});

test('an oversized local replay is skipped without GitHub or model credentials', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'goby-replay-'));
  try {
    const diff = join(cwd, 'change.diff');
    writeFileSync(diff, 'one\ntwo\n');
    const run = spawnSync('bun', [join(root, 'scripts/replay.ts'), '--diff', diff, '--max-diff-lines', '1'],
      {cwd, env: cleanEnv, encoding: 'utf8'});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Skipped:');
    expect(run.stdout).toContain('"skipped"');
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});
