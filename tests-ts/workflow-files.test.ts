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

test('the reviewer is bounded by turns, a command timeout and a job timeout', () => {
  // pi has no turn cap of its own, and a shell command with no wall clock can hang until the job
  // timeout — which is how a four-minute review turned into fifteen minutes. The numbers are image
  // defaults, so a change reaches every consumer through `:latest` instead of a workflow edit.
  for (const file of ['review/workflow.yml', '.github/workflows/goby-review.yml']) {
    const text = read(file);
    expect(text).not.toContain('GOBY_MAX_TURNS:');
    expect(text).not.toContain('GOBY_BASH_TIMEOUT_S:');
    expect(text).toContain('timeout-minutes: 15');
  }
  const defaults = read('review/defaults.env');
  expect(defaults).toContain('GOBY_MAX_TURNS:=50');
  expect(defaults).toContain('GOBY_BASH_TIMEOUT_S:=120');
  expect(read('review/entrypoint.sh')).toContain('source /opt/goby/defaults.env');
  expect(read('review/Dockerfile')).toContain('review/defaults.env');
  const extension = read('review/report_findings.ts');
  expect(extension).toContain("pi.on('turn_start'");
  expect(extension).toContain('turns > MAX_TURNS');
  // Budget notices and the wrap-up turn are append-only: a custom message is added to the turn
  // boundary, never a rewrite of the transcript prefix.
  expect(extension).toContain("pi.on('turn_end'");
  expect(extension).toContain("customType: 'goby-budget'");
  expect(extension).toContain('event.entries');
  // `nextTurn` only flushes on a new agent run, which `pi --print` never starts; the notice has to
  // go through the boundary entries instead.
  expect(extension).not.toContain('pi.sendMessage');
  expect(extension).toContain('continue: true');
  // The bash tool takes cwd first: passing options in that slot silently drops both the env filter
  // and the timeout.
  expect(extension).toContain('createBashTool(process.cwd(), {');
  // pi's exec takes seconds and converts them itself; multiplying here made "120 s" ~33 hours.
  expect(extension).not.toContain('COMMAND_TIMEOUT_S * 1000');
});


test('the reviewer\'s own code carries briefs, so a cleaner can debug the reviewer', () => {
  // Without an INVARIANTS.md a directory is invisible to the post-merge cleaner, which is how the
  // reviewer would be the one part of this project nothing ever scanned.
  const {existsSync} = require('node:fs') as typeof import('node:fs');
  for (const dir of ['review', 'src']) {
    const path = join(root, dir, 'INVARIANTS.md');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# ');
    expect(text.split('\n').filter(line => /^\d+\. /.test(line)).length).toBeGreaterThanOrEqual(3);
  }
});

test('a pull request is reviewed once by default', () => {
  expect(read('review/defaults.env')).toContain('GOBY_MAX_ROUNDS:=1');
  for (const file of ['review/workflow.yml', '.github/workflows/goby-review.yml']) {
    expect(read(file)).not.toContain('GOBY_MAX_ROUNDS:');
  }
  expect(read('docs/configuration.md')).toContain('reviews per pull request');
});
