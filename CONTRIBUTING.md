# Contributing

Goby's production implementation is TypeScript. Node 20+ runs the bundle;
Bun 1.4.4 and TypeScript build and test it. `gdp-wired` is the sole direct
runtime dependency; avoid adding dependencies for ordinary transport or parsing.

## Checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

This typechecks, kernel-checks the production policies, builds the Node CLI,
and runs offline tests. Test model/GitHub traffic through injected transports;
default tests must not call external services. Add a failing regression for
any behavior change, especially retries, publication, or gate eligibility.

## Policy changes

The gate, turn budget, and review lifecycle execute compiled rules from
`src/core/rules.ts`. Change that rule, its laws, and tests together. Do not
reimplement the decision in a caller. Require `proven && checked` and preserve
an unsafe mutant that the checker or tests reject. Proofs establish these
rules, not model accuracy or the freshness of an external service.

## Python reference

`reference/python/` is frozen migration evidence, not another runtime to
maintain. `tests-ts/fixtures/generate_contract_diff.py` regenerates the
checked-in pure-code corpus from it. Normal tests use JSON and need no Python.
Document intentional parity differences instead of silently weakening tests.

## Try a change

```sh
export CORALBRICKS_API_KEY=...
export GITHUB_TOKEN=...
node dist/cli.js review --pr <number> --dry-run --agent
```

Dry-run never posts. Do not check out or execute code from a PR in a trusted
review workflow. Keep changes focused and explain the reason for safety rules.

## Commits

Use conventional commit subjects and `git commit -s` for the Developer
Certificate of Origin. A sign-off certifies that you wrote the contribution
or have the right to submit it. No publication or remote change without the
owner's approval. See [security](SECURITY.md) and [extensions](docs/extensions.md).
