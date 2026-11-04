import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dir, '..');
const workflow = readFileSync(join(root, 'review/workflow.yml'), 'utf8');

test('the review workflow runs on pull_request, never pull_request_target', () => {
  // pull_request_target executes from the base branch with secrets present; this job then clones
  // and runs the pull request. That combination is the one thing the design cannot allow.
  expect(workflow).toContain('pull_request:');
  // The comment above warns about it by name; the trigger itself must not be there.
  expect(workflow).not.toMatch(/^\s*pull_request_target:/m);
});

test('the image is pinned by digest, not by tag', () => {
  expect(workflow).toMatch(/image: ghcr\.io\/[a-z0-9./-]+@sha256:[0-9a-f]{64}/);
  expect(workflow).not.toMatch(/image: [^\s]+:latest/);
});

test('permissions are the whole grant and forks are skipped', () => {
  for (const scope of ['contents: read', 'pull-requests: write', 'statuses: write', 'packages: read']) {
    expect(workflow).toContain(scope);
  }
  expect(workflow).not.toContain('actions: write');
  expect(workflow).toContain('head.repo.full_name == github.repository');
});

test('the job names the entrypoint, because a container job drops the image ENTRYPOINT', () => {
  expect(workflow).toContain('run: /opt/goby/entrypoint.sh');
  expect(workflow).not.toContain('actions/checkout');
});

test('it passes the commit under review, not just the pull request number', () => {
  for (const name of ['GOBY_REPO', 'GOBY_PR', 'GOBY_HEAD', 'GOBY_BASE']) expect(workflow).toContain(`${name}:`);
  expect(workflow).toContain('pull_request.head.sha');
  expect(workflow).toContain('pull_request.base.sha');
});
