/**
 * Which pull request a gate recheck is about, from the event that triggered it.
 *
 * This used to be an inline script inside the workflow file, which meant the one piece of logic in
 * the gate path with no test. It is a pure function here: an event plus a mode in, `{pr, head}` or
 * "there is no unambiguous PR" out.
 *
 * `workflow_run` publishes `pull_requests` on the run, and the honest answer when it holds zero or
 * several entries is to change nothing — guessing would re-gate a pull request nobody asked about.
 */
export interface GateTarget {
  pr: number;
  head: string;
}

export interface GateEvent {
  name: string;
  event: Record<string, unknown>;
  inputs?: { pr?: string; head?: string };
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function resolve_gate_target({ name, event, inputs }: GateEvent): GateTarget | string {
  if (name === 'workflow_dispatch' || name === 'workflow_call') {
    const pr = Number(inputs?.pr);
    const head = String(inputs?.head ?? '');
    if (!Number.isSafeInteger(pr) || pr < 1) return 'workflow_dispatch needs a positive pr input';
    if (!SHA.test(head)) return 'workflow_dispatch needs a full head SHA input';
    return { pr, head };
  }
  const run = event.workflow_run as { pull_requests?: unknown } | undefined;
  const pullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  if (pullRequests.length !== 1) return 'no unambiguous PR identity; no gate will be changed';
  const entry = pullRequests[0] as { number?: unknown; head?: { sha?: unknown } };
  const pr = Number(entry.number);
  const head = String(entry.head?.sha ?? '');
  if (!Number.isSafeInteger(pr) || pr < 1 || !SHA.test(head)) return 'invalid PR number or head SHA in the event';
  return { pr, head };
}
