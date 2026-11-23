import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChanges } from '../src/codeRun.ts';

// A goby-review finding on #221 showed `readChanges` dropped a manifest entry's `mode` silently,
// which meant an executable file or a symlink the agent produced reached `create_tree` with no
// mode at all and got GitHub's hardcoded 100644 default — losing the executable bit, and turning
// a symlink's blob content (its target path) into a committed regular file. This locks the field in.
describe('readChanges', () => {
  test('carries mode through for a regular file, an executable, a symlink, and a delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goby-code-changes-'));
    const path = join(dir, 'changes.json');
    const manifest = [
      { path: 'a.ts', content: 'export {}', mode: '100644' },
      { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', mode: '100755' },
      { path: 'link', content: 'a.ts', mode: '120000' },
      { path: 'old.ts', content: null },
    ];
    await writeFile(path, JSON.stringify(manifest));
    try {
      const changes = await readChanges(path);
      expect(changes).toEqual(manifest);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an entry with no mode (the deleted-file case) leaves it undefined, not defaulted here', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goby-code-changes-'));
    const path = join(dir, 'changes.json');
    await writeFile(path, JSON.stringify([{ path: 'gone.ts', content: null }]));
    try {
      const changes = await readChanges(path);
      expect(changes).toEqual([{ path: 'gone.ts', content: null, mode: undefined }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
