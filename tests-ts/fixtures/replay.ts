import { readFileSync } from 'node:fs';
import { Finding } from '../../src/core/contract.ts';

export interface Receipt {
  case: string;
  namespace: string;
  name: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
export const corpus = JSON.parse(readFileSync(new URL('./contract-diff.json', import.meta.url), 'utf8')) as {
  original_tests: number;
  system_prompt: string;
  calls: Receipt[];
};
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function hydrate(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hydrate);
  if (!isObject(v)) return v;
  if ('$number' in v) return v.$number === 'nan' ? NaN : v.$number === 'inf' ? Infinity : -Infinity;
  if ('$finding' in v) {
    const input = v.$finding as ConstructorParameters<typeof Finding>[0] & { fid: string };
    const finding = new Finding(input);
    finding.fid = input.fid;
    return finding;
  }
  return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, hydrate(value)]));
}
export function snapshot(v: unknown): unknown {
  if (v instanceof Finding) return { $finding: { ...v } };
  if (Array.isArray(v)) return v.map(snapshot);
  if (typeof v === 'number' && !Number.isFinite(v)) return { $number: Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf' };
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, snapshot(value)]));
  return v;
}
const parameters: Record<string, string[]> = {
  parse_findings: ['text', 'strict'],
  select_findings: ['findings', 'max_findings'],
  build_user_prompt: ['diff', 'repo_context', 'already_raised', 'already_resolved', 'pr_intent', 'repo_map'],
  split_already_raised: ['findings', 'open_threads'],
  split_resolved_rederivations: ['findings', 'resolved_history'],
};
export function replay(module: object, receipt: Receipt): unknown {
  const args = receipt.args.map(hydrate);
  if (receipt.name === 'Finding') return snapshot(new Finding(hydrate(receipt.kwargs) as ConstructorParameters<typeof Finding>[0]));
  for (const [key, value] of Object.entries(receipt.kwargs)) {
    const index = parameters[receipt.name]?.indexOf(key) ?? -1;
    if (index < 0) throw new Error(`Unmapped keyword ${receipt.name}.${key}`);
    args[index] = hydrate(value);
  }
  // The only dynamic boundary: receipt names/arguments are data from the corpus.
  const methods = module as Record<string, (...args: unknown[]) => unknown>;
  return snapshot(methods[receipt.name](...args));
}
