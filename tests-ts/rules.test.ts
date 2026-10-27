import {describe, expect, test} from 'bun:test';
import {bool, fun, proveDecision, when} from 'gdp-wired';
import {gateAllowed, gateFields, provePolicies, ReviewLifecycle, TurnBudget, turnRule, turnLaws, turnSteps} from '../src/core/rules.ts';

describe('executable gdp-wired policy foundation', () => {
  test('all Boolean gate combinations', () => {
    for (let mask = 0; mask < 1 << gateFields.length; mask++) {
      const facts = Object.fromEntries(gateFields.map((field, i) => [field, Boolean(mask & (1 << i))]));
      expect(gateAllowed(facts as Parameters<typeof gateAllowed>[0])).toBe(mask === (1 << gateFields.length) - 1);
    }
  });
  test('kernel checks policy laws', () => expect(provePolicies()).toEqual({gateLaws: 11, turnLaws: 5, lifecycleLaws: 3, checked: true}));
  test('unsafe completion-only mutant is refused', () => {
    const broken = fun('unsafe').inputs({execution: bool, clean: bool}).returns(x => ({allowed: when(x.execution, 1, 0)}));
    expect(proveDecision(broken.law('Findings block', () => [], (out, x) => out.allowed.eq(1).implies(x.clean))).proven).toBe(false);
  });
  test('cap and final are enforced by production rule', () => {
    const budget = new TurnBudget(2, 1000);
    expect([budget.take(0), budget.take(100), budget.take(200), budget.take(300), budget.take(400)])
      .toEqual(['regular', 'regular', 'final', 'stop', 'stop']);
  });
  test('first turn still sees diff, deadline closes later turns', () => {
    const budget = new TurnBudget(20, 1);
    expect([budget.take(99), budget.take(100), budget.take(101)]).toEqual(['regular', 'final', 'stop']);
  });
  test('invalid budgets are refused', () => {
    for (const n of [0, -1, 1.5, NaN, Infinity]) expect(() => new TurnBudget(n, 10)).toThrow();
    expect(() => new TurnBudget(1, 0)).toThrow();
    expect(() => new TurnBudget(1, 1).take(NaN)).toThrow();
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
  test('rule callbacks match compiled evaluation', () => {
    expect(turnRule.crossCheck(turnLaws, turnSteps).checked).toBeGreaterThan(0);
  });
});
