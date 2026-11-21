import { describe, expect, test } from 'bun:test';
import { instanceSuffix, marker, statusContext } from '../src/identity.ts';

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
});
