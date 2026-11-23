import { describe, expect, test } from 'bun:test';
import { out_of_scope } from '../src/core/scope.ts';

describe('out_of_scope', () => {
  test('no changed paths is nothing out of scope, whatever the allowlist', () => {
    expect(out_of_scope([], [])).toEqual([]);
    expect(out_of_scope([], ['src/**'])).toEqual([]);
  });

  test('an empty allowlist fails closed: every changed path is out of scope', () => {
    expect(out_of_scope(['a.ts', 'b/c.ts'], [])).toEqual(['a.ts', 'b/c.ts']);
  });

  test('exact path match', () => {
    expect(out_of_scope(['a.ts'], ['a.ts'])).toEqual([]);
    expect(out_of_scope(['a.ts'], ['b.ts'])).toEqual(['a.ts']);
  });

  test('single-segment star does not cross directories', () => {
    expect(out_of_scope(['src/a.ts'], ['src/*.ts'])).toEqual([]);
    expect(out_of_scope(['src/sub/a.ts'], ['src/*.ts'])).toEqual(['src/sub/a.ts']);
  });

  test('double-star crosses directories, including zero segments', () => {
    expect(out_of_scope(['src/sub/deep/a.ts'], ['src/**'])).toEqual([]);
    expect(out_of_scope(['src/a.ts'], ['src/**'])).toEqual([]);
    expect(out_of_scope(['src'], ['src/**'])).toEqual([]);
  });

  test('a glob anywhere in the pattern, not just the tail', () => {
    expect(out_of_scope(['a/x/b.ts', 'a/y/b.ts'], ['a/**/b.ts'])).toEqual([]);
    expect(out_of_scope(['a/b.ts'], ['a/**/b.ts'])).toEqual([]);
  });

  test('multiple globs: a path out of every one of them is reported', () => {
    const allow = ['src/**', 'docs/*.md'];
    expect(out_of_scope(['src/a.ts', 'docs/readme.md', 'other/x.ts'], allow)).toEqual(['other/x.ts']);
  });

  test('a leading ./ or / is normalised before matching', () => {
    expect(out_of_scope(['./src/a.ts'], ['src/**'])).toEqual([]);
    expect(out_of_scope(['/src/a.ts'], ['src/**'])).toEqual([]);
  });

  test('a path with a .. segment is rejected even when it would textually match', () => {
    expect(out_of_scope(['src/../etc/passwd'], ['**'])).toEqual(['src/../etc/passwd']);
    expect(out_of_scope(['../escape.ts'], ['**'])).toEqual(['../escape.ts']);
    expect(out_of_scope(['src/..'], ['src/**'])).toEqual(['src/..']);
  });

  test('a glob is trimmed of surrounding whitespace before matching', () => {
    expect(out_of_scope(['src/a.ts'], ['  src/** '])).toEqual([]);
  });

  test('everything allowed with a bare **', () => {
    expect(out_of_scope(['anything/at/all.ts', 'top.ts'], ['**'])).toEqual([]);
  });

  test('question mark matches exactly one non-slash character', () => {
    expect(out_of_scope(['a/x1.ts'], ['a/x?.ts'])).toEqual([]);
    expect(out_of_scope(['a/x12.ts'], ['a/x?.ts'])).toEqual(['a/x12.ts']);
  });

  test('a dot in a glob is literal, not a wildcard', () => {
    expect(out_of_scope(['src/axts'], ['src/a.ts'])).toEqual(['src/axts']);
    expect(out_of_scope(['src/a.ts'], ['src/a.ts'])).toEqual([]);
  });
});
