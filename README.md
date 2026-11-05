# goby

An AI code-review agent that reads the code before it comments — and, for a pull request, runs it.

Goby ships two halves of one crew. **Review** reads a pull request before it merges: it clones the
change into a container, hands it to an agent with a shell, and posts bugs on the exact lines.
**Cleaners** (`cleaners/`) reads the default branch after every push, reproduces what it suspects,
and files one issue per defect it can prove — see [`cleaners/README.md`](cleaners/README.md).

Licensed under [Apache-2.0](LICENSE).

- **A sandboxed clone, not a diff skim.** The reviewer can run the project's tests, write a probe,
  patch a line and re-run. Findings quote what it ran, not just what it read.
- **The code under review cannot reach the credentials.** It runs as an unprivileged uid with an
  empty environment; the GitHub token and the model key live in root-only files, and the agent
  reaches the model through a loopback proxy that holds the real key. See
  [`docs/trust-model.md`](docs/trust-model.md).
- **Bugs only:** a findings contract, a strict parser, and a retraction filter that keeps a
  withdrawn claim out of the output.
- **Re-reviews without repeating itself:** deduplication by span, resolved-thread history, and
  cleanup of outdated threads.
- **Fail-closed gate:** a receipt bound to head, base and diff; findings accounted for as live
  threads; complete thread data; successful execution. `Goby Review` is telemetry, `Goby Gate` is
  eligibility.
- **Proven gate rules:** the gate executes a compiled `gdp-wired` rule over ten Boolean facts, and
  CI kernel-checks its laws (plus the review lifecycle's).

## Layout

| path | what it is |
|---|---|
| `base/` | `goby-base` image: pi, git, ripgrep, python3, the key proxy, the secret conventions |
| `review/` | reviewer image: `FROM goby-base`, the prompt, the emit tool, the entrypoint |
| `cleaners/` | the post-merge cleaner, its own image, its own CLEANER.md contract |
| `src/core/contract.ts` | findings shape, parser, retraction, dedupe, re-derivation matching |
| `src/core/selection.ts` | which findings may be posted, and which are withheld and why |
| `src/core/gate.ts`, `verdict.ts`, `rules.ts` | receipts, the model-free recheck, and the rules |
| `src/core/gateEvent.ts` | which PR a `workflow_run` handoff is about |
| `src/reviewRun.ts` | the two GitHub-facing halves: `prepare` before the agent, `finish` after |
| `src/platforms/` | GitHub transport and publication |
| `scripts/gate.ts` | recheck eligibility locally, no model key needed |

## Install

Copy [`review/workflow.yml`](review/workflow.yml) and
[`examples/workflows/goby-gate.yml`](examples/workflows/goby-gate.yml) into `.github/workflows/`, add
the model key as a secret, and pick what branch protection requires. The image runs `:latest`, and
each review names the digest it resolved. Details: [`docs/quickstart.md`](docs/quickstart.md).

Never use `pull_request_target` for the reviewer: it runs from the base branch with secrets
present, and then executes the pull request.

## Develop and verify

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check   # typecheck → kernel-checked policies → Node build → offline tests
docker build -t goby-base base
docker build -t goby-review -f review/Dockerfile .
```

The tests are offline: the contract corpus, diff and line-positioning rules, the key proxy against
a stub upstream, publication against a stubbed GitHub, the gate over every Boolean combination of
its facts, and the workflow files' own invariants (digest pins, no `pull_request_target`).

Goby never merges itself. Before it replaces a hosted reviewer it needs a historical-PR quality
comparison — that is unexecuted, not done. The open work lives in the issue tracker.
