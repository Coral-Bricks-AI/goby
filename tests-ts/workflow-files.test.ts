import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('neither workflow uses pull_request_target', () => {
  // That trigger runs from the base branch with secrets present; the review job then executes the
  // pull request. It is the one combination the design cannot allow.
  for (const file of ['review/workflow.yml', 'examples/workflows/goby-gate.yml']) {
    expect(read(file)).not.toMatch(/^\s*pull_request_target:/m);
  }
});

test('every workflow pins its image by digest', () => {
  for (const file of ['review/workflow.yml', 'examples/workflows/goby-gate.yml']) {
    for (const match of read(file).matchAll(/^\s+image:\s*(\S+)/gm)) {
      expect(match[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  }
});

test('the gate recheck reads its target from the event, with no inline script', () => {
  const gate = read('examples/workflows/goby-gate.yml');
  expect(gate).toContain('GOBY_MODE: gate');
  expect(gate).toContain('GOBY_EVENT_FILE: ${{ github.event_path }}');
  // No embedded program: the resolution lives in src/core/gateEvent.ts, where it has tests.
  expect(gate).not.toContain('node --input-type=module');
  expect(gate).not.toContain('actions/github-script');
});

test('the review workflow passes the commits under review and skips forks', () => {
  const review = read('review/workflow.yml');
  for (const name of ['GOBY_REPO', 'GOBY_PR', 'GOBY_HEAD', 'GOBY_BASE']) expect(review).toContain(`${name}:`);
  expect(review).toContain('pull_request.head.sha');
  expect(review).toContain('pull_request.base.sha');
  expect(review).toContain('head.repo.full_name == github.repository');
  expect(review).not.toContain('actions/checkout');
  expect(review).toContain('run: /opt/goby/entrypoint.sh');
});

test('drafts and the no-review label skip the reviewer', () => {
  // A pull request under construction should not pay a model call per push, and a change to the
  // reviewer itself cannot be reviewed by the reviewer it is changing.
  for (const file of ['review/workflow.yml', '.github/workflows/goby-review.yml']) {
    const text = read(file);
    expect(text).toContain('github.event.pull_request.draft == false');
    expect(text).toContain("contains(github.event.pull_request.labels.*.name, 'no-review')");
    expect(text).toContain('head.repo.full_name == github.repository');
  }
});

test('CI stays one job on one Node version', () => {
  const text = read('.github/workflows/ci.yml');
  expect(text).not.toMatch(/^\s+matrix:/m);
  expect(text).not.toContain('docker/build-push-action');
  expect(text).toContain('bun run check');
});
