# Contract and diff corpus

`contract-diff.json` is a checked-in fixture corpus: 453 recorded calls plus the
exact system prompt, covering the pure contract and diff behavior. `bun test`
loads it as JSON; nothing else is involved at test time.

The corpus was captured while porting Goby from its Python prototype, and that
prototype is gone. It is a **fixture now, not a generated artifact**: there is no
regenerator, edits are made by hand or by adding tests in
`tests-ts/contract.test.ts` and `tests-ts/diff.test.ts`.

Read it as *behaviors we pin*, including the ones that look arbitrary — they were
specific bugs or silent-failure modes in an earlier review of the same code:

| pinned behavior | why |
|---|---|
| sizes and read windows counted in Unicode code points, not UTF-16 units | a 4-byte emoji is one character in a file or read budget; counting units makes a "120k character" read silently shorter for non-ASCII code |
| `SequenceMatcher` matching blocks, asymmetric tie-breaking, normalization, 200-character autojunk | hunk ranges decide which lines GitHub lets us comment on; a different diff algorithm moves comments to the wrong lines |
| the strict parser accepts exactly the documented findings shapes and nothing else | a lenient parser turns model prose into posted findings |
| retraction boundaries are Unicode-aware and whitespace-explicit | a retracted claim must not resurface because of spacing or a dotted/dotless I |
| line coordinates are numbers or numeric strings, `end_line` is never `undefined` | a published finding's position is the one thing a reviewer cannot fix after the fact |

If one of these assertions is in your way, read its reason above before changing
it: most of them cost someone a wrong comment.

## Public integration surface

- `Finding` is constructed with `{path, line, severity, title, detail?, end_line?}`.
  Its `end_line` is always a number or null; it exposes `fid`, `span()`, and
  `rekey()`. `FindingRecord` is the data-only shape for publishers/serialization;
  functions requiring identity/span methods should receive `Finding` instances.
- `ThreadRecord` is structural, with optional fields; numeric coordinate strings
  as well as numbers are accepted. Extra fields on existing record types are
  retained, and `plan_thread_resolution<T>` returns those same objects.
- `parse_findings(text, {strict: true})` (also `parse_findings(text, true)`) returns
  `Finding[] | null`. It does not itself filter paths or drop retractions; path
  filtering and retraction are separate, composable steps.
- The public names keep the original `snake_case` spelling and tuple return
  order, so the corpus and the call sites read the same. `Hunks` is a path-keyed
  object; `parse_hunks` uses a null prototype so all file names are safe. `Hunk`
  accepts `{new_start, new_count}`.
- `build_user_prompt` keeps a positional argument order, including nullable
  optional lists, PR intent, and repository map.

## Boundaries

The SequenceMatcher implementation preserves matching-block behavior, asymmetric
tie-breaking, normalization, Unicode code-point indexing, and the 200-character
autojunk threshold; it is not a Levenshtein approximation. Normal file
coordinates and every originally covered regression are pinned here.

Coordinates are JavaScript numbers, so beyond 2^53 they can lose precision (and
extreme integer literals beyond the finite range become non-finite). The
corpus's large-integer regression verifies acceptance, not arbitrary-precision
equality — loading the expected corpus also uses JavaScript numbers, so do not
infer more precision from it than that. Non-finite line values raise `RangeError`
in lenient mode and return `null` in strict mode.

Retraction word boundaries and whitespace are explicitly Unicode-aware, but the
Unicode database and case-folding version follow the JavaScript engine, and
special case-insensitive regex equivalences (notably dotted/dotless I) are not
guaranteed. Typed constructors are designed for their declared types; runtime
coercion of invalid arguments is not emulated.

The port adds no runtime dependencies beyond native Node APIs.

## Model transport is stateless by design

The agent loop resends the whole transcript every turn and sends `store: false`;
it never continues a stored response with `previous_response_id`. A gateway under
zero data retention has no stored turn to continue and rejects that parameter, and
a reviewer must not leave prompt content behind at the provider. This corpus does
not cover the agent loop, so no captured call pins transport behavior in either
direction — the loop's own tests do.
