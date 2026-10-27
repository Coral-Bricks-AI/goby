import {createHash} from 'node:crypto';
import {gateAllowed, type GateFacts} from './rules.ts';

export interface ReviewReceipt {
  schema: 2;
  head_sha: string;
  base_ref: string;
  diff_sha256: string;
  complete: boolean;
  agent: boolean;
  unthreaded: number;
  finding_ids: string[];
}
export interface GateResult {head_sha: string; state: 'success' | 'failure' | 'error'; description: string}
export interface GateThread {fid?: string; sha?: string}
const PREFIX = '<!-- goby-gate ';
export const validSha = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
export function diffDigest(diff: string): string { return createHash('sha256').update(diff).digest('hex'); }
export function receiptMarker(receipt: ReviewReceipt): string { return `${PREFIX}${JSON.stringify(receipt)} -->`; }
export function parseReceipt(body: string, commit: string): ReviewReceipt | null {
  const lines = body.split(/\r?\n/).filter(line => line.startsWith(PREFIX));
  if (lines.length !== 1 || !lines[0].endsWith(' -->')) return null;
  try {
    const data: unknown = JSON.parse(lines[0].slice(PREFIX.length, -4));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const r = data as Record<string, unknown>;
    if (Object.keys(r).sort().join(',') !== 'agent,base_ref,complete,diff_sha256,finding_ids,head_sha,schema,unthreaded') return null;
    if (r.schema !== 2 || typeof r.base_ref !== 'string' || !r.base_ref || typeof r.diff_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.diff_sha256) || !validSha(r.head_sha) || r.head_sha !== commit || typeof r.complete !== 'boolean' || typeof r.agent !== 'boolean') return null;
    if (!Number.isSafeInteger(r.unthreaded) || (r.unthreaded as number) < 0 || !Array.isArray(r.finding_ids)) return null;
    if (!r.finding_ids.every(id => typeof id === 'string' && /^[0-9a-f]+$/.test(id)) || new Set(r.finding_ids).size !== r.finding_ids.length) return null;
    return r as unknown as ReviewReceipt;
  } catch { return null; }
}
export function evaluateGate(receipt: ReviewReceipt | null, head: string, opened: GateThread[], resolved: GateThread[], complete: boolean, executionSucceeded: boolean, evidence?: {base_ref: string; diff_sha256: string}): GateResult {
  const observed = new Set([...opened, ...resolved].filter(t => t.sha === head.slice(0, 10) || t.sha === head).map(t => t.fid));
  const facts: GateFacts = {
    receipt_valid: receipt !== null,
    same_head: receipt?.head_sha === head,
    complete: receipt?.complete === true,
    agent: receipt?.agent === true,
    no_unthreaded: receipt?.unthreaded === 0,
    threads_complete: complete,
    findings_accounted: receipt !== null && receipt.finding_ids.every(id => observed.has(id)),
    no_open_threads: opened.length === 0,
    execution_succeeded: executionSucceeded,
    diff_matches: !!receipt && !!evidence && receipt.base_ref === evidence.base_ref && receipt.diff_sha256 === evidence.diff_sha256,
  };
  const reasons: Record<keyof GateFacts, string> = {
    receipt_valid: 'No valid review receipt for this head', same_head: 'Review belongs to a different commit',
    complete: 'Review incomplete (budget exhausted or answer truncated)', agent: 'An agentic review is required',
    no_unthreaded: 'Unthreaded or capped findings require a new review after a fix',
    threads_complete: 'Thread state is incomplete; refusing to guess', findings_accounted: 'Published finding threads are missing',
    no_open_threads: `${opened.length} unresolved Goby finding(s)`, execution_succeeded: 'Latest review execution did not succeed',
    diff_matches: 'PR base or diff changed since this review; a new review is required',
  };
  if (gateAllowed(facts)) return {head_sha: head, state: 'success', description: 'Complete review; no unresolved Goby findings'};
  const key = (Object.keys(facts) as (keyof GateFacts)[]).find(key => facts[key] !== true)!;
  return {head_sha: head, state: 'failure', description: reasons[key]};
}
