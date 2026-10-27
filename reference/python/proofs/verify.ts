// Development-only proof; Goby's runtime remains Python standard-library-only.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bool, fun, proveDecision, when} from 'gdp-wired';

const fields = [
  'receipt_valid', 'same_head', 'complete', 'agent', 'no_unthreaded',
  'threads_complete', 'findings_accounted', 'no_open_threads', 'execution_succeeded',
] as const;
const inputs = Object.fromEntries(fields.map(key => [key, bool]));
const policy = fun('Goby merge eligibility').inputs(inputs).returns(x => ({
  allowed: when(fields.map(key => x[key]).reduce((a, b) => a.and(b)), 1, 0),
}));
for (const field of fields) {
  const law = policy.law(`Permission requires ${field}`, () => [],
    (out, x) => out.allowed.eq(1).implies(x[field]));
  const verdict = proveDecision(law);
  if (!verdict.proven || !verdict.checked) throw new Error(JSON.stringify({field, verdict}));
}
const positive = policy.law('All facts suffice', () => [], (out, x) =>
  fields.map(key => x[key]).reduce((a, b) => a.and(b)).implies(out.allowed.eq(1)));
const positiveVerdict = proveDecision(positive);
if (!positiveVerdict.proven || !positiveVerdict.checked) throw new Error(JSON.stringify(positiveVerdict));

// Compare EVERY input with the actual Python function, not a second handwritten
// reference. This finite decision has 2^9 inputs; no bounded-sample proof claim.
const root = fileURLToPath(new URL('..', import.meta.url));
const python = `
import itertools, json
from goby.core.verdict import gate_allowed
fields = ${JSON.stringify(fields)}
print(json.dumps([{'input': dict(zip(fields, bits)), 'allowed': gate_allowed(**dict(zip(fields, bits)))}
                  for bits in itertools.product((False, True), repeat=len(fields))]))
`;
const rows = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', python], {
  cwd: root, env: {...process.env, PYTHONPATH: root + '/src'}, encoding: 'utf8',
}));
for (const row of rows) {
  const actual = policy.run(row.input).allowed === 1;
  if (actual !== row.allowed) throw new Error(`Python/proof mismatch: ${JSON.stringify(row)}`);
}

// Preserve the old mistake as a mutant: completion alone grants permission.
const broken = fun('Completion is not permission').inputs(inputs)
  .returns(x => ({allowed: when(x.execution_succeeded, 1, 0)}));
const refused = proveDecision(broken.law('Bugs still block', () => [],
  (out, x) => out.allowed.eq(1).implies(x.no_open_threads)));
if (refused.proven) throw new Error('Unsafe completion-only gate was accepted');
console.log(JSON.stringify({laws: fields.length + 1, proven: true, checked: true,
  pythonCases: rows.length, unsafeMutantRejected: true}));
