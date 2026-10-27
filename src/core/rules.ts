import {all, bool, fun, nat, oneOf, proveDecision, proveSteps, rule, when} from 'gdp-wired';

export const gateFields = [
  'receipt_valid', 'same_head', 'complete', 'agent', 'no_unthreaded',
  'threads_complete', 'findings_accounted', 'no_open_threads', 'execution_succeeded', 'diff_matches',
] as const;
export type GateFacts = Record<(typeof gateFields)[number], boolean>;
const gateInputs = Object.fromEntries(gateFields.map(key => [key, bool]));
export const gateRule = fun('Goby review eligibility').inputs(gateInputs).returns(x => ({
  allowed: when(all(...gateFields.map(key => x[key])), 1, 0),
}));

/** Production executes the compiled rule, not a look-alike Boolean expression. */
export function gateAllowed(facts: GateFacts): boolean {
  if (gateFields.some(key => typeof facts[key] !== 'boolean')) return false;
  return gateRule.run(facts).allowed === 1;
}

export const turnRule = rule('Goby agent turn admission')
  .params({limit: nat, wall: nat})
  .pre(({limit, wall}) => limit.atLeast(1).and(wall.atLeast(1)))
  .inputs({elapsed: nat})
  .state({regular: 0, finals: 0, decision: 0})
  .flags(({regular, finals, limit, wall, elapsed}) => ({
    admitRegular: finals.eq(0).and(regular.lt(limit), regular.eq(0).or(elapsed.lt(wall))),
  }))
  .step(({regular, finals, admitRegular}) => ({
    regular: regular.plus(when(admitRegular, 1, 0)),
    finals: finals.plus(when(finals.eq(0).and(admitRegular.not()), 1, 0)),
    decision: when(admitRegular, 1, when(finals.eq(0), 2, 0)),
  }));

export const turnLaws = [
  turnRule.law('Regular calls never exceed the configured limit', ({regular, limit}) => regular.atMost(limit)),
  turnRule.law('At most one final call', ({finals}) => finals.atMost(1)),
  turnRule.law('Total calls never exceed limit plus one', ({regular, finals, limit}) => regular.plus(finals).atMost(limit.plus(1))),
];
export const turnSteps = [
  turnRule.stepLaw('A final closes admission permanently', ({finals}, after) =>
    finals.eq(1).implies(after.decision.eq(0))),
  turnRule.stepLaw('No regular turn after the deadline except the first', ({regular, elapsed, wall}, after) =>
    regular.gt(0).and(elapsed.atLeast(wall)).implies(after.decision.eq(1).not())),
];

export type TurnAdmission = 'regular' | 'final' | 'stop';
export class TurnBudget {
  private readonly runtime = turnRule.compiled();
  private readonly params;
  private state;
  constructor(limit: number, wallMs: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(wallMs) || wallMs <= 0 || wallMs > Number.MAX_SAFE_INTEGER) {
      throw new Error('Turn limit must be a positive integer and wall budget positive and finite');
    }
    this.params = turnRule.encodeParams({limit, wall: Math.ceil(wallMs)});
    this.state = this.runtime.init(this.params);
  }
  take(elapsedMs: number): TurnAdmission {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > Number.MAX_SAFE_INTEGER) throw new Error('Invalid elapsed time');
    this.state = this.runtime.step(this.params, this.state, turnRule.encodeInput({elapsed: Math.floor(elapsedMs)}));
    const decision = turnRule.decode(this.state).decision;
    if (decision === 1) return 'regular';
    if (decision === 2) return 'final';
    return 'stop';
  }
}

export type ReviewEvent = 'fetched' | 'started' | 'complete' | 'incomplete' | 'skipped' | 'error' | 'superseded' | 'reused';
export type ReviewPhase = 'idle' | 'ready' | 'running' | 'complete' | 'incomplete' | 'skipped' | 'error' | 'superseded';
const phases: ReviewPhase[] = ['idle', 'ready', 'running', 'complete', 'incomplete', 'skipped', 'error', 'superseded'];
export const reviewRule = rule('Goby review lifecycle')
  .inputs({event: oneOf('fetched', 'started', 'complete', 'incomplete', 'skipped', 'error', 'superseded', 'reused')})
  .state({phase: 0, accepted: 0})
  .flags(({phase, event}) => ({allowed:
    event.is('fetched').and(phase.eq(0))
      .or(event.is('started').and(phase.eq(1)))
      .or(event.is('complete').or(event.is('incomplete')).and(phase.eq(2)))
      .or(event.is('skipped').or(event.is('reused')).and(phase.eq(1)))
      .or(event.is('error').or(event.is('superseded')).and(phase.atMost(2))),
  }))
  .step(({phase, event, allowed}) => ({
    accepted: when(allowed, 1, 0),
    phase: when(allowed,
      when(event.is('fetched'), 1, when(event.is('started'), 2,
        when(event.is('complete').or(event.is('reused')), 3,
          when(event.is('incomplete'), 4, when(event.is('skipped'), 5,
            when(event.is('error'), 6, 7)))))), phase),
  }));
export const reviewLaws = [reviewRule.law('Lifecycle phase stays valid', ({phase}) => phase.atMost(7))];
export const reviewSteps = [
  reviewRule.stepLaw('Terminal results cannot be rewritten', ({phase}, after) => phase.atLeast(3).implies(after.phase.eq(phase))),
  reviewRule.stepLaw('New success requires a completed run or validated reuse', ({phase, event}, after) =>
    phase.lt(3).and(after.phase.eq(3)).implies(event.is('complete').and(phase.eq(2)).or(event.is('reused').and(phase.eq(1))))),
];
export class ReviewLifecycle {
  private readonly runtime = reviewRule.compiled();
  private readonly params = reviewRule.encodeParams({});
  private state = this.runtime.init(this.params);
  get phase(): ReviewPhase { return phases[Number(reviewRule.decode(this.state).phase)]; }
  transition(event: ReviewEvent): void {
    const next = this.runtime.step(this.params, this.state, reviewRule.encodeInput({event}));
    if (reviewRule.decode(next).accepted !== 1) throw new Error(`Invalid review transition ${this.phase} -> ${event}`);
    this.state = next;
  }
}

/** Run in CI; no theorem search or external solver at review time. */
export function provePolicies(): {gateLaws: number; turnLaws: number; lifecycleLaws: number; checked: true} {
  for (const key of gateFields) {
    const proof = proveDecision(gateRule.law(`Eligibility requires ${key}`, () => [],
      (out, input) => out.allowed.eq(1).implies(input[key])));
    if (!proof.proven || !proof.checked) throw new Error(`Unproven gate law: ${key}`);
  }
  const positive = proveDecision(gateRule.law('All established facts suffice', () => [],
    (out, input) => all(...gateFields.map(key => input[key])).implies(out.allowed.eq(1))));
  if (!positive.proven || !positive.checked) throw new Error('Unproven positive gate law');
  const budget = proveSteps(turnRule, turnLaws, turnSteps, {search: false});
  if (!budget.proven || !budget.checked) throw new Error(`Unproven turn budget: ${JSON.stringify(budget)}`);
  const lifecycle = proveSteps(reviewRule, reviewLaws, reviewSteps, {search: false});
  if (!lifecycle.proven || !lifecycle.checked) throw new Error(`Unproven review lifecycle: ${JSON.stringify(lifecycle)}`);
  return {gateLaws: gateFields.length + 1, turnLaws: turnLaws.length + turnSteps.length, lifecycleLaws: reviewLaws.length + reviewSteps.length, checked: true};
}
