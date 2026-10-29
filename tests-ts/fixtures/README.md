# Contract and diff parity corpus

Regenerate offline from the unmodified Python reference:

```sh
python3 tests-ts/fixtures/generate_contract_diff.py
bun test tests-ts/contract.test.ts tests-ts/diff.test.ts
```

The generator AST-extracts 77 pure tests from the frozen
`reference/python/tests/test_harness.py`. It does
not import the harness's platform/provider modules, require pytest, call a
model, or use the network. It checks the original assertions, records calls
and pre-mutation argument snapshots, then adds deterministic strict-parser,
Unicode, SequenceMatcher/autojunk, thread, prompt, and malformed-diff probes.
`contract-diff.json` contains 453 reference calls and the exact system prompt.
Bun runs that checked-in corpus without requiring Python at test time.

## Public integration surface

- `Finding` is constructed with `{path, line, severity, title, detail?, end_line?}`.
  Its `end_line` is always a number or null; it exposes `fid`, `span()`, and
  `rekey()`. `FindingRecord` is the data-only shape for publishers/serialization;
  functions requiring identity/span methods should receive `Finding` instances.
- `ThreadRecord` is structural, with optional fields; numeric coordinate strings
  as well as numbers are accepted. Extra fields on existing record types are
  retained, and `plan_thread_resolution<T>` returns those same objects.
- `parse_findings(text, {strict: true})` (also `parse_findings(text, true)`) returns
  `Finding[] | null`. It does not itself filter paths or drop retractions, matching
  Python's separation of those operations.
- Python snake_case names and tuple return order are retained. `Hunks` is a
  path-keyed object; `parse_hunks` uses a null prototype so all file names are safe.
  `Hunk` accepts `{new_start, new_count}`.
- `build_user_prompt` retains Python's positional argument order, including
  nullable optional lists, PR intent, and repository map.

## Parity boundaries

Normal file coordinates and all original covered regressions match the reference.
The SequenceMatcher implementation preserves Python's matching-block algorithm,
asymmetric tie-breaking, normalization, Unicode code-point indexing, and the
200-character autojunk threshold; it is not a Levenshtein approximation.

JavaScript numbers are not Python arbitrary-precision integers. Beyond 2^53,
coordinates can lose precision (and extreme integer literals beyond the JS
finite range become non-finite). Large finite `end_line` values are accepted,
and `NaN`, `Infinity`, and overflowing float exponents are handled. The corpus's
large-integer regression verifies acceptance, not arbitrary-precision equality;
JSON loading the expected corpus also uses JavaScript numbers. Do not infer
bigint parity from that test. Non-finite line values raise RangeError in lenient
mode and return null in strict mode, corresponding to Python's conversion error.

JavaScript and Python can ship different Unicode database/case-folding versions.
Retraction word boundaries and whitespace are explicitly Unicode-aware, but
Python's special case-insensitive regex equivalences (notably dotted/dotless I)
and lone-surrogate UTF-8 error behavior are not guaranteed identical. Typed
constructors/coordinate inputs are designed for their declared types; arbitrary
Python runtime coercions of invalid arguments are not emulated.

The port adds no runtime dependencies beyond native Node APIs.

## Intentional divergence: model transport statefulness

The frozen Python reference continues its agent loop with
`previous_response_id`, keeping the conversation gateway-side. The TypeScript
runtime resends the whole transcript and sends `store: false` instead. This is
deliberate: a gateway under zero data retention has no stored turn to continue
and rejects the request, so the reference's threading cannot work there, and a
reviewer must not leave prompt content behind at the provider. Only the
transport differs — prompts, findings contract, parsing, publication, and gate
eligibility are unchanged, and the contract/diff corpus does not cover the
agent loop, so no captured call pins the old behavior.
