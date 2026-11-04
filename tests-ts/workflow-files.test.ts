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

test('the publish workflow tells the reader which digest to pin', () => {
  // Automating this was tried and is not possible with `GITHUB_TOKEN`: the pin lives in a workflow
  // file, and no permission on that token allows updating one. So the publish job prints the digest
  // and a human makes the one-line change.
  const publish = read('.github/workflows/review-image.yml');
  expect(publish).toContain('Tell the reader which digest to pin');
  expect(publish).not.toContain('git push origin main');
  expect(publish).not.toContain('workflows:');
});

test('every workflow parses under actionlint rules we rely on', () => {
  // A bad `permissions:` scope makes a workflow invalid, and GitHub then refuses to run it at all —
  // which is how a "grant" turned the publish pipeline off. CI runs actionlint; this test states the
  // one property that bit: no scope outside the allowed set.
  const allowed = new Set(['actions', 'artifact-metadata', 'attestations', 'checks', 'contents',
    'deployments', 'discussions', 'id-token', 'issues', 'models', 'packages', 'pages',
    'pull-requests', 'repository-projects', 'security-events', 'statuses']);
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/review-image.yml',
    '.github/workflows/cleaners-image.yml', '.github/workflows/cleaners-post-merge.yml',
    '.github/workflows/test-cleaners.yml', '.github/workflows/goby-review.yml']) {
    const block = read(file).split(/^permissions:$/m)[1];
    if (!block) continue;
    for (const line of block.split('\n')) {
      const match = /^\s{2}([a-z-]+):/.exec(line);
      if (!match) { if (line.trim() === '' || !line.startsWith('  ')) break; continue; }
      expect(allowed.has(match[1])).toBe(true);
    }
  }
});
