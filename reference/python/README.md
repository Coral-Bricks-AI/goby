# Frozen Python migration reference

Production Goby is TypeScript in the repository's `src/` and runs as a bundled
Node CLI. Nothing in the action imports or executes this directory.

This snapshot preserves the Python implementation and the local fail-closed
gate work so differential fixtures can be regenerated and investigated. It is
not a second supported runtime. Its final pre-archive run passed 792 tests.

Regenerate the checked-in pure-code corpus from the repository root:

```sh
python3 tests-ts/fixtures/generate_contract_diff.py
```

Optionally run the frozen Python tests from this directory:

```sh
uv run --no-project --with pytest env PYTHONPATH=src python -m pytest tests
```

Do not add new production features here. Add TypeScript tests and evolve the
executable gdp-wired policies in `src/core/rules.ts` instead.
