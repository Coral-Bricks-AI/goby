import { describe, expect, test } from 'bun:test';
import { code_branch_name, parse_allowed_paths, resolve_task_source, round_decision } from '../src/core/codePlan.ts';

describe('resolve_task_source', () => {
  test('a .goby/tasks/ prefix is a file reference', () => {
    expect(resolve_task_source('.goby/tasks/nightly-fix.md')).toEqual({ inline: false, path: '.goby/tasks/nightly-fix.md' });
  });

  test('anything else is inline text, verbatim', () => {
    expect(resolve_task_source('Fix the flaky test in foo.ts')).toEqual({ inline: true, text: 'Fix the flaky test in foo.ts' });
  });

  test('leading/trailing whitespace around the task does not change inline text, only the prefix check', () => {
    expect(resolve_task_source('  .goby/tasks/x.md  ')).toEqual({ inline: false, path: '.goby/tasks/x.md' });
  });

  test('a path that merely contains .goby/tasks/ but does not start with it is inline', () => {
    expect(resolve_task_source('see .goby/tasks/x.md for details')).toEqual({ inline: true, text: 'see .goby/tasks/x.md for details' });
  });
});

describe('parse_allowed_paths', () => {
  test('splits on newlines and commas, trims, drops empties', () => {
    expect(parse_allowed_paths('src/**\ndocs/*.md, common/**\n\n')).toEqual(['src/**', 'docs/*.md', 'common/**']);
  });

  test('a single glob with no separators', () => {
    expect(parse_allowed_paths('src/**')).toEqual(['src/**']);
  });

  test('an empty string yields no globs', () => {
    expect(parse_allowed_paths('')).toEqual([]);
    expect(parse_allowed_paths('   ')).toEqual([]);
  });
});

describe('code_branch_name', () => {
  test('deterministic from the base sha, short-form', () => {
    expect(code_branch_name('0123456789abcdef')).toBe('goby/code-0123456789');
  });

  test('carries the instance suffix when set, keeping two instances apart', () => {
    expect(code_branch_name('0123456789abcdef', 'nightly')).toBe('goby/code-nightly-0123456789');
  });
});

describe('round_decision', () => {
  test('no open threads: stop, no escalation', () => {
    expect(round_decision({ round: 1, maxRounds: 3, openThreads: 0 })).toEqual({ continue: false, escalate: false, reason: null });
  });

  test('open threads under the cap: continue', () => {
    const decision = round_decision({ round: 1, maxRounds: 3, openThreads: 2 });
    expect(decision.continue).toBe(true);
    expect(decision.escalate).toBe(false);
  });

  test('open threads at the cap: escalate, with a reason', () => {
    const decision = round_decision({ round: 3, maxRounds: 3, openThreads: 1 });
    expect(decision.continue).toBe(false);
    expect(decision.escalate).toBe(true);
    expect(decision.reason).toContain('3 round(s)');
  });

  test('round past the cap (defensive) still escalates rather than looping', () => {
    const decision = round_decision({ round: 5, maxRounds: 3, openThreads: 1 });
    expect(decision.escalate).toBe(true);
  });
});
