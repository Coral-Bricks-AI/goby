import {describe, expect, test} from 'bun:test';
import {bool, fun, proveDecision, when} from 'gdp-wired';
import {gateAllowed, gateFields, provePolicies, ReviewLifecycle} from '../src/core/rules.ts';

describe('executable gdp-wired policy foundation', () => {
  test('all Boolean gate combinations', () => {
    for (let mask = 0; mask < 1 << gateFields.length; mask++) {
      const facts = Object.fromEntries(gateFields.map((field, i) => [field, Boolean(mask & (1 << i))]));
      expect(gateAllowed(facts as Parameters<typeof gateAllowed>[0])).toBe(mask === (1 << gateFields.length) - 1);
    }
  });
  test('kernel checks policy laws', () => expect(provePolicies()).toEqual({gateLaws: 11, lifecycleLaws: 3, checked: true}));
  test('unsafe completion-only mutant is refused', () => {
    const broken = fun('unsafe').inputs({execution: bool, clean: bool}).returns(x => ({allowed: when(x.execution, 1, 0)}));
    expect(proveDecision(broken.law('Findings block', () => [], (out, x) => out.allowed.eq(1).implies(x.clean))).proven).toBe(false);
  });
  test('terminal lifecycle states cannot be rewritten', () => {
    const lifecycle = new ReviewLifecycle();
    lifecycle.transition('fetched');
    lifecycle.transition('started');
    lifecycle.transition('error');
    expect(lifecycle.phase).toBe('error');
    expect(() => lifecycle.transition('complete')).toThrow();
    expect(lifecycle.phase).toBe('error');
  });
});
