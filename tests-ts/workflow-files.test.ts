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
    '.github/workflows/test-cleaners.yml', '.github/workflows/test-review-image.yml',
    '.github/workflows/goby-review.yml', '.github/workflows/tide-scheduled.yml',
    '.github/workflows/tide-image.yml', '.github/workflows/test-tide.yml',
    'wake/workflow.yml', '.github/workflows/goby-wake.yml',
    '.github/workflows/wake-image.yml', '.github/workflows/test-wake.yml']) {
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
  for (const file of ['.github/workflows/review-image.yml', '.github/workflows/wake-image.yml']) {
    const publish = read(file);
    expect(publish).toContain('refs/heads/${GITHUB_DEFAULT_BRANCH:-main}');
    const latestPush = publish.slice(publish.indexOf('if [[ "$GITHUB_REF"'));
    expect(latestPush.indexOf('docker push --quiet "$image:latest"'))
      .toBeLessThan(latestPush.indexOf('fi'));
  }
});

test('the reviewer is bounded by turns, a command timeout, an agent deadline and a job timeout', () => {
  // pi has no turn cap of its own, and a shell command with no wall clock can hang until the job
  // timeout — which is how a four-minute review turned into fifteen minutes. The numbers are image
  // defaults, so a change reaches every consumer through `:latest` instead of a workflow edit.
  for (const file of ['review/workflow.yml', '.github/workflows/goby-review.yml']) {
    const text = read(file);
    expect(text).not.toContain('GOBY_MAX_TURNS:');
    expect(text).not.toContain('GOBY_BASH_TIMEOUT_S:');
    // The agent's deadline is image-owned for the same reason, and it has to be the one that fires:
    // a job the runner stops runs no shell of ours, so nothing resolves the statuses `prepare` posted.
    expect(text).not.toContain('GOBY_AGENT_TIMEOUT_S:');
    expect(text).toContain('timeout-minutes: 15');
  }
  const defaults = read('review/defaults.env');
  expect(defaults).toContain('GOBY_MAX_TURNS:=50');
  expect(defaults).toContain('GOBY_BASH_TIMEOUT_S:=120');
  expect(defaults).toContain('GOBY_AGENT_TIMEOUT_S:=600');
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
  for (const dir of ['review', 'src', 'tide', 'wake']) {
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


test('two products are scheduled — the tide sweeps, the wake reads — and the schedule is the consumer\'s', () => {
  // A cron expression cannot read an input, so it is the one knob that stays in the workflow a
  // consumer copies. Everything else arrives through `:latest`, which is why no product may sneak
  // a second scheduled workflow in without this test changing.
  const tide = read('.github/workflows/tide-scheduled.yml');
  expect(tide).toContain('schedule:');
  expect(tide).toContain('cron:');
  expect(tide).toContain('workflow_dispatch:');
  expect(tide).toContain('workflow_call:');
  expect(tide).toContain('goby-tide:latest');
  expect(tide).not.toMatch(/goby-tide@sha256/);
  expect(tide).not.toMatch(/^\s*pull_request_target:/m);
  // The run has to be able to file issues and pull the image; nothing else.
  expect(tide).toContain('issues: write');
  expect(tide).toContain('packages: read');
  expect(tide).toContain('run: bash /opt/tide/entrypoint.sh');
  // The reader is the second scheduled product and the only one that writes nothing: no issue, no
  // status, no comment. A `write` scope here would make a reader able to change the repository it
  // is reading, which is a larger surface than a schedule needs.
  const wake = read('wake/workflow.yml');
  expect(wake).toContain('schedule:');
  expect(wake).toContain('cron:');
  expect(wake).toContain('workflow_dispatch:');
  expect(wake).toContain('goby-wake:latest');
  expect(wake).not.toMatch(/goby-wake@sha256/);
  expect(wake).not.toMatch(/^\s*pull_request_target:/m);
  for (const scope of ['pull-requests: read', 'issues: read', 'actions: read']) {
    expect(wake).toContain(scope);
  }
  for (const forbidden of ['issues: write', 'statuses: write', 'pull-requests: write',
    'contents: write']) {
    expect(wake).not.toContain(forbidden);
  }
  // `schedule` cannot read inputs, so the window is a repository variable, and the cron is the one
  // thing a consumer edits by hand.
  expect(wake).toContain('vars.GOBY_WAKE_DAYS');
  expect(wake).toContain('node /opt/wake/wake.js');
  for (const other of ['review/workflow.yml', '.github/workflows/goby-review.yml',
    '.github/workflows/cleaners-post-merge.yml']) {
    expect(read(other)).not.toContain('schedule:');
  }
})

test('a container step is sh, so it carries no bash-only shell option', () => {
  // Container jobs run `run:` steps with `sh -e` — dash on these images — where `set -o pipefail`
  // is not an option and a pipeline reports the *last* command's status. Both halves bit on the
  // first scheduled run: `| tee` made a failed read a green step, and `set -euo pipefail` aborted
  // the ship step before it ran. A step that is expected to fail on failure has to be written for
  // the shell it actually gets.
  for (const file of ['wake/workflow.yml', '.github/workflows/goby-wake.yml']) {
    const code = read(file).split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toContain('pipefail');
    // No pipeline into `tee`: the status would be tee's, not the reader's.
    expect(code).not.toMatch(/^\s*run: node .*\|/m);
    expect(code).toContain('> /tmp/wake.json');
  }
})

test('the wake this repository runs is the wake it ships', () => {
  // One file, copied, exactly as a consumer copies it: the cron line is the part a repository
  // owns, and this repository reading its own history is what "works well enough" is decided
  // from. A copy that drifted would mean the thing being dogfooded is not the thing being shipped.
  expect(read('.github/workflows/goby-wake.yml')).toBe(read('wake/workflow.yml'));
})

test('a scheduled sweep never cancels another, and is not keyed on the commit', () => {
  // On a schedule `github.sha` is the branch head, so keying concurrency on it would let two
  // ticks over the same head run together; cancelling one can leave an issue half-filed.
  const tide = read('.github/workflows/tide-scheduled.yml');
  expect(tide).toContain('group: goby-tide');
  expect(tide).not.toContain('group: goby-tide-${{');
  expect(tide).toContain('cancel-in-progress: false');
})

test('every product that files issues files under its own label plus the general one', () => {
  // `label:goby` lists everything goby filed in a repository; `label:goby-tide` only the
  // scheduled ones. The shared module adds the general label, so a product opts in by passing its
  // own name — and a product that files without going through `common/issues.py` would lose it.
  const common = read('common/issues.py');
  expect(common).toContain('GENERAL = "goby"');
  expect(common).toMatch(/return \[self\.label\.name, \*/);
  for (const [file, label] of [['cleaners/post_findings.py', 'goby-cleaners'],
    ['tide/post_issues.py', 'goby-tide']] as const) {
    const text = read(file);
    expect(text).toContain(`LABEL = "${label}"`);
    expect(text).toContain('import issues as common');
    expect(text).toContain('common.file_issues');
  }
})

test('the shared filing code exists once, in one directory', () => {
  // Two copies of the dedupe read is how the two products would drift into disagreeing about what
  // a duplicate is. Both images copy `common/`; neither owns a copy of it.
  const {existsSync} = require('node:fs') as typeof import('node:fs');
  for (const name of ['issues.py', 'model_check.py', 'summarize_run.py', 'usage.py']) {
    expect(existsSync(join(root, 'common', name))).toBe(true);
    for (const product of ['cleaners', 'tide']) {
      expect(existsSync(join(root, product, name))).toBe(false);
    }
  }
  for (const dockerfile of ['cleaners/Dockerfile', 'tide/Dockerfile']) {
    expect(read(dockerfile)).toContain('COPY common/issues.py /opt/common/issues.py');
    // Every product image is built on `goby-base`, so pi, the uid drop and the key proxy exist
    // once. A product that re-installs pi is a second version of the agent in the same repo.
    expect(read(dockerfile)).toContain('FROM ${BASE_IMAGE}');
    expect(read(dockerfile)).toContain('ARG BASE_IMAGE=goby-base');
  }
})

test('an image is republished when anything its Dockerfile copies changes', () => {
  // The reviewer image copies `common/` (the run summary and the timing tool) and
  // `review-image.yml` did not watch it, so a change to `common/timing.py` merged and published
  // nothing: `:latest` kept running the old bytes while the log said the new ones were live. The
  // paths a workflow watches have to cover every COPY source in the image it publishes.
  const images: [string, string][] = [
    ['review/Dockerfile', '.github/workflows/review-image.yml'],
    ['cleaners/Dockerfile', '.github/workflows/cleaners-image.yml'],
    ['tide/Dockerfile', '.github/workflows/tide-image.yml'],
    ['wake/Dockerfile', '.github/workflows/wake-image.yml'],
  ];
  for (const [dockerfile, workflow] of images) {
    const paths = read(workflow);
    for (const line of read(dockerfile).split('\n')) {
      const match = /^COPY\s+(.+)$/.exec(line.trim());
      // `--from` copies out of a build stage: those bytes come from this repository's own source,
      // which the workflow already watches through `src/` or the product directory.
      if (!match || line.includes('--from')) continue;
      // The last token is the destination.
      for (const source of match[1].trim().split(/\s+/).slice(0, -1)) {
        // A directory is watched by its prefix; a file either by its own path or by the glob of
        // the directory it sits in.
        const top = source.split('/')[0];
        const watched = [`"${source}"`, `"${top}/**"`];
        expect({ dockerfile, source, watches: watched.some(w => paths.includes(w)) })
          .toEqual({ dockerfile, source, watches: true });
      }
    }
  }
});
