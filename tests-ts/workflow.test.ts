import {test, expect} from 'bun:test';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const source = readFileSync(resolve(import.meta.dir, '../examples/workflows/goby-gate.yml'), 'utf8');
const marker = "          node --input-type=module <<'JS'\n";
const script = source.slice(source.indexOf(marker) + marker.length, source.indexOf('\n          JS'))
  .split('\n').map(line => line.slice(10)).join('\n');
function run(event: unknown, name = 'workflow_run', inputs: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'goby-workflow-'));
  try {
    const eventPath = join(cwd, 'event.json'), output = join(cwd, 'output');
    writeFileSync(eventPath, JSON.stringify(event)); writeFileSync(output, '');
    const result = spawnSync('node', ['--input-type=module', '-e', script], {cwd, encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: name, ...inputs,
    }});
    return {status: result.status, output: readFileSync(output, 'utf8')};
  } finally { rmSync(cwd, {recursive: true, force: true}); }
}

test('handoff uses PR head, never the workflow merge SHA', () => {
  const prHead = 'a'.repeat(40);
  const result = run({workflow_run: {head_sha: 'b'.repeat(40), pull_requests: [{number: 9, head: {sha: prHead}}]}});
  expect(result).toEqual({status: 0, output: `pr=9\nhead=${prHead}\n`});
});
test('ambiguous or missing PR identity changes no gate', () => {
  for (const prs of [[], [{number: 1}, {number: 2}]]) expect(run({workflow_run: {pull_requests: prs}})).toEqual({status: 0, output: ''});
});
test('dispatch inputs are validated before producing outputs', () => {
  expect(run({}, 'workflow_dispatch', {INPUT_PR: '3', INPUT_HEAD: 'a'.repeat(40)}).status).toBe(0);
  for (const inputs of [{INPUT_PR: '3\npr=99', INPUT_HEAD: 'a'.repeat(40)}, {INPUT_PR: '3', INPUT_HEAD: '$(touch bad)'}]) {
    const result = run({}, 'workflow_dispatch', inputs); expect(result.status).not.toBe(0); expect(result.output).toBe('');
  }
});
test('workflow retains identity and permission boundaries', () => {
  expect(source).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  expect(source).not.toContain('actions/checkout');
  expect(source).not.toContain('gh pr merge');
  expect(source).toContain('statuses: write');
});
