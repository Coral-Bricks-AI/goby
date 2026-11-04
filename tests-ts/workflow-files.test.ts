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

test('every workflow runs the moving tag, and passes it through for attribution', () => {
  // Pinning meant a one-line commit per change and GitHub tokens cannot edit workflow files, so the
  // tag is under this repository's control and the digest is recorded in the review instead.
  for (const file of ['review/workflow.yml', 'examples/workflows/goby-gate.yml', '.github/workflows/goby-review.yml']) {
    const text = read(file);
    expect(text).toContain('goby-review:latest');
    expect(text).not.toMatch(/goby-review@sha256/);
  }
  // Only the reviewer writes a body, so only it needs the reference handed to the publisher for
  // digest resolution; the gate makes no model call and writes nothing but a status. The reviewer
  // aliases it so a pin cannot move one without the other.
  for (const file of ['review/workflow.yml', '.github/workflows/goby-review.yml']) {
    expect(read(file)).toContain('GOBY_IMAGE: *goby_image');
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

test('the publish workflow still prints the digest, for anyone who wants to pin it', () => {
  const publish = read('.github/workflows/review-image.yml');
  expect(publish).toContain('Print the digest');
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


test('the image is named once, so a pin cannot change the label without the runtime', () => {
  // Reporting a digest for an image the job did not run is worse than reporting nothing.
  for (const file of ['review/workflow.yml', '.github/workflows/goby-review.yml']) {
    const text = read(file);
    expect(text).toContain('image: &goby_image ghcr.io/coral-bricks-ai/goby-review:latest');
    expect(text).toContain('GOBY_IMAGE: *goby_image');
    expect(text).not.toMatch(/GOBY_IMAGE: ghcr\.io/);
  }
});

test('only the default branch may move the moving tag', () => {
  // `:latest` is the runtime now, so a release tag or a dispatch on an older commit must not
  // re-publish that older image as the one everything runs.
  const publish = read('.github/workflows/review-image.yml');
  expect(publish).toContain('refs/heads/${GITHUB_DEFAULT_BRANCH:-main}');
  const latestPush = publish.slice(publish.indexOf('if [[ "$GITHUB_REF"'));
  expect(latestPush.indexOf('docker push --quiet "$image:latest"'))
    .toBeLessThan(latestPush.indexOf('fi'));
});
