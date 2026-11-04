# goby

An AI code-review agent that reads the code before it comments.

Goby ships two halves of one crew. **Review** (this file, `action.yml`) reads a pull request
before it merges and posts bugs on the exact lines. **Cleaners** (`cleaners/`) reads the
default branch after every push, reproduces what it suspects, and files an issue per defect it
can prove — see [`cleaners/README.md`](cleaners/README.md).

Licensed under [Apache-2.0](LICENSE).

Goby is TypeScript on Node, with **gdp-wired as its executable policy
foundation**. It reads code around a pull request, posts bugs on the exact
lines, and keeps review completion separate from merge eligibility.

- **Reads before it reports:** a bounded tool loop with `read_file`,
  `list_dir`, `grep`, and `file_history`. Multi-file reads are batched: one
  GraphQL request per 100 files instead of one request per file.
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
bun run check   # typecheck → kernel-checked policies → Node build → offline tests
```

The loop is stateless by construction — every turn resends the whole transcript — so a gateway
under zero data retention can serve it; there is no stored-turn continuation to fail.

`gdp-wired` is the sole direct runtime dependency. No Python, PyPI package,
or unpublished major tag is needed. Publishing remains owner-controlled.

## Add it to a repository

Copy [`examples/workflows/goby-review.yml`](examples/workflows/goby-review.yml) into
`.github/workflows/`, and replace `<GOBY_COMMIT_SHA>` with the full commit SHA you reviewed:

```sh
git ls-remote https://github.com/Coral-Bricks-AI/goby.git refs/heads/main
```

A tag would be a movable handle over executable code, so the workflow carries a commit — and
that commit is the entire "trusted source" claim: the action builds only its own pinned source
and never checks out PR code.

Then add `CORALBRICKS_API_KEY` as a repository secret, and require **Goby Gate** plus CI in
branch protection — not Goby Review, which is execution telemetry. Fork PRs are skipped by the
workflow; see the [trust model](docs/trust-model.md).

**Do not gate merges on Goby Review.** That compatibility status means the
review ran, including when it found bugs or skipped a large diff. The separate
Goby Gate verdict fails closed. The action fails on a blocked gate by default.

## Review and recheck

The review runs as the action, from `action.yml`. Two scripts cover the local cases:

```sh
export CORALBRICKS_API_KEY=... GITHUB_TOKEN=...
bun run scripts/replay.ts --diff change.diff --repo owner/name --head-sha <sha>  # never posts
bun run scripts/gate.ts --pr 123 --expected-head <full-pr-head-sha>             # no model, no key
```

A maintainer can resolve inline findings and refresh the gate without another model call.
Deleted/missing threads do not count as resolved. Summary-only or capped findings require a new
review after a fix; incomplete reviews are automatically eligible for rerun.

For a historical comparison, replay a saved diff at its commit as above; a token enables pinned
code reads. See
[quickstart](docs/quickstart.md), [configuration](docs/configuration.md), and
[merge integration](docs/merge-gate.md).

## Develop and verify

```sh
bun run check  # typecheck → kernel-checked policies → Node build → offline tests
```

The test suite pins the pure contract and diff behavior against a checked-in
corpus of 453 recorded calls, plus provider retries, tool bounds, and full
review/gate scenarios. Tests are offline and need no Python. See
[the corpus](tests-ts/fixtures/README.md) for what it pins and why.

| path | responsibility |
|---|---|
| `src/core/rules.ts` | executable gate, turn-budget, and lifecycle rules |
| `src/core/review.ts` | acquisition → model → selection → publication → gate |
| `src/core/gate.ts`, `verdict.ts` | trusted receipts and model-free rechecks |
| `src/core/agent.ts` | read-only tools and bounded agent loop |
| `src/core/contract.ts`, `diff.ts` | findings, dedupe, and line positioning |
| `src/providers/`, `src/platforms/` | model and GitHub transport |
| `tests-ts/prove.ts` | kernel-check the exact production rules |

The action spins up with `bun install --frozen-lockfile --ignore-scripts` and a build from that
pinned source, so there is no published package to trust and none to keep in sync.

Goby never merges itself. Before it replaces a hosted reviewer it needs a historical-PR quality
comparison — that is unexecuted, not done. See [TODO](TODO.md). Licensed under
[Apache-2.0](LICENSE).
