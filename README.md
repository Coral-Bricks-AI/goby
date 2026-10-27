# goby

An AI code-review agent that reads the code before it comments.

Goby is TypeScript on Node, with **gdp-wired as its executable policy
foundation**. It reads code around a pull request, posts bugs on the exact
lines, and keeps review completion separate from merge eligibility.

- **Reads before it reports:** a bounded tool loop with `read_file`,
  `list_dir`, `grep`, and `file_history`.
- **Bugs only:** a findings contract, strict parser, and retraction filter.
- **Re-reviews without repeating itself:** deduplication, resolved-thread
  history, and cleanup of outdated threads.
- **Fail-closed gate:** head/base/diff-bound receipts, accounted-for findings, complete
  thread data, and successful review execution are all required.
- **Proven control flow:** the runtime executes gdp-wired's compiled gate,
  turn-admission, and review-lifecycle rules. CI kernel-checks 19 laws;
  terminal results cannot be rewritten and at most one final turn is admitted.

## Build and run

Node 20+ runs the bundle; Bun 1.4.4 builds and tests it.

```sh
git clone https://github.com/Coral-Bricks-AI/goby.git
cd goby
bun install --frozen-lockfile --ignore-scripts
bun run build
node dist/cli.js version
node dist/cli.js --help
# Optional: bun link makes the local `goby` command available.
```

`gdp-wired` is the sole direct runtime dependency. No Python, PyPI package,
or unpublished major tag is needed. Publishing remains owner-controlled.

## Add it to a repository

From the target repo, run the built CLI and pin a **reviewed full Goby SHA**:

```sh
node /path/to/goby/dist/cli.js init --ref <full-goby-commit-sha>
```

Add the `CORALBRICKS_API_KEY` repository secret, commit the generated workflow,
and require **Goby Gate** plus CI in branch protection. The action builds only
its own pinned source and never checks out PR code. Fork PRs are skipped by
the generated workflow; see the [trust model](docs/trust-model.md).

**Do not gate merges on Goby Review.** That compatibility status means the
review ran, including when it found bugs or skipped a large diff. The separate
Goby Gate verdict fails closed. The action fails on a blocked gate by default.

## Review and recheck

```sh
goby doctor
goby review --pr 123 --dry-run --agent
goby review --pr 123 --agent --fail-on-blocked
goby gate --pr 123 --expected-head <full-pr-head-sha>
```

A maintainer can resolve inline findings and refresh the gate without another
model call. Deleted/missing threads do not count as resolved. Summary-only or
capped findings require a new review after a fix. `--force` explicitly reruns
an unchanged head; incomplete reviews are automatically eligible for rerun.

For a historical comparison, use `--diff-file`, `--head-sha`, `--repo`, and
`--dry-run --agent`. A token enables pinned code reads. See
[quickstart](docs/quickstart.md), [configuration](docs/configuration.md), and
[merge integration](docs/merge-gate.md).

## Develop and verify

```sh
bun run check  # typecheck → kernel-checked policies → Node build → offline tests
```

The test suite includes 453 captured Python reference calls for the pure
contract/diff behavior, provider retries, tool bounds, and full review/gate
scenarios. `reference/python/` is a frozen migration oracle, not a supported
runtime. Production tests do not require Python. See
[parity boundaries](tests-ts/fixtures/README.md).

| path | responsibility |
|---|---|
| `src/core/rules.ts` | executable gate, turn-budget, and lifecycle rules |
| `src/core/review.ts` | acquisition → model → selection → publication → gate |
| `src/core/gate.ts`, `verdict.ts` | trusted receipts and model-free rechecks |
| `src/core/agent.ts` | read-only tools and bounded agent loop |
| `src/core/contract.ts`, `diff.ts` | findings, dedupe, and line positioning |
| `src/providers/`, `src/platforms/` | model and GitHub transport |
| `tests-ts/prove.ts` | kernel-check the exact production rules |

Goby never merges itself. Production rollout still needs a sandbox GitHub
check and a historical-PR quality comparison before removing a hosted
reviewer. License: to be chosen (intended Apache-2.0); until then, all rights
reserved. See [TODO](TODO.md) and [contributing](CONTRIBUTING.md).
