import { describe, expect, test } from 'bun:test';
import { escapeForRegExp, instanceSuffix, marker, statusContext } from '../src/identity.ts';

describe('GOBY_INSTANCE', () => {
  test('unset leaves the default marker and status context unchanged', () => {
    expect(instanceSuffix({})).toBe('');
    expect(marker({})).toBe('goby');
    expect(statusContext({})).toBe('Goby Review');
  });

  test('set, it salts the marker and suffixes the status context', () => {
    const env = { GOBY_INSTANCE: 'deepseek' };
    expect(marker(env)).toBe('goby-deepseek');
    expect(statusContext(env)).toBe('Goby Review (deepseek)');
  });

  test('is trimmed, and blank is treated as unset', () => {
    expect(instanceSuffix({ GOBY_INSTANCE: '  deepseek  ' })).toBe('deepseek');
    expect(marker({ GOBY_INSTANCE: '   ' })).toBe('goby');
    expect(statusContext({ GOBY_INSTANCE: '' })).toBe('Goby Review');
  });

  test("a salted marker cannot be mistaken for the default instance's", () => {
    // own_thread_record / own_reviews match on the literal `<!-- ${MARKER} ` — a hyphen right
    // after `goby` must not satisfy a check for the bare `goby` marker.
    const salted = marker({ GOBY_INSTANCE: 'deepseek' });
    expect(`<!-- ${salted} id=1 -->`.includes('<!-- goby ')).toBe(false);
  });

  test('an instance name can contain regex metacharacters without widening or breaking the match', () => {
    // A model name is a plausible GOBY_INSTANCE (`v4.1`'s `.`), and an unescaped `.` in a RegExp
    // source matches any character, not the literal dot it was written as.
    const m = marker({ GOBY_INSTANCE: 'deepseek-v4.1' });
    const pattern = escapeForRegExp(m);
    const re = new RegExp(`<!-- ${pattern} id=(\\w+)`);
    expect(m).toBe('goby-deepseek-v4.1');
    expect('<!-- goby-deepseek-v4.1 id=abc -->'.match(re)?.[1]).toBe('abc');
    // The dot must not become a wildcard: a different character in its place must not match.
    expect('<!-- goby-deepseekxv4.1 id=abc -->'.match(re)).toBeNull();
  });

  test('an instance name with an unbalanced bracket does not throw building the pattern', () => {
    // Before MARKER was escaped at each RegExp call site, a value like `a[` made `new RegExp(...)`
    // throw out of every reader that builds one from MARKER (github.ts, wake/records.ts).
    const m = marker({ GOBY_INSTANCE: 'a[' });
    expect(() => new RegExp(`<!-- ${escapeForRegExp(m)} id=(\\w+)`)).not.toThrow();
  });
});
