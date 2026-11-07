# goby

An AI code-review agent that reads the code before it comments — and, for a pull request, runs it.

Goby ships three parts of one crew, each on its own clock. **Review** reads a pull request before
it merges: it clones the change into a container, hands it to an agent with a shell, and posts bugs
on the exact lines. **Cleaners** (`cleaners/`) reads the default branch after every push,
reproduces what it suspects, and files one issue per defect it can prove — see
[`cleaners/README.md`](cleaners/README.md). **Tide** (`tide/`) sweeps the default branch on a
schedule, measures the code that has become hard to work in, and files one issue per smell with a
plan to remove it — see [`tide/README.md`](tide/README.md).

The two that file issues put two labels on each: their own (`goby-cleaners`, `goby-tide`) and the
general `goby`, so `label:goby` lists everything goby filed in a repository.

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
| `cleaners/` | cleaner image: `FROM goby-base`, the post-merge scan, its own INVARIANTS.md contract |
| `tide/` | the scheduled sweep: `FROM goby-base`, the detector, the prompt, the entrypoint |
| `common/` | what both issue-filing products share: `issues.py`, `model_check.py`, `usage.py`, the provider model files |
| `src/core/contract.ts` | findings shape, parser, retraction, dedupe, re-derivation matching |
| `src/core/selection.ts` | which findings may be posted, and which are withheld and why |
| `src/core/gate.ts`, `verdict.ts`, `rules.ts` | receipts, the model-free recheck, and the rules |
| `src/core/gateEvent.ts` | which PR a `workflow_run` handoff is about |
| `src/reviewRun.ts` | the two GitHub-facing halves: `prepare` before the agent, `finish` after |
| `src/platforms/` | GitHub transport and publication |
| `scripts/gate.ts` | recheck eligibility locally, no model key needed |

## Install

Each product is one file to copy plus the model key as a secret:

- [`review/workflow.yml`](review/workflow.yml) and
  [`examples/workflows/goby-gate.yml`](examples/workflows/goby-gate.yml) for the reviewer — see
  [`docs/quickstart.md`](docs/quickstart.md);
- [`.github/workflows/cleaners-post-merge.yml`](.github/workflows/cleaners-post-merge.yml) for the
  post-merge cleaner;
- [`.github/workflows/tide-scheduled.yml`](.github/workflows/tide-scheduled.yml) for the scheduled
  sweep. The `cron` line in that file is yours to set — it is the one knob a repository keeps its
  own copy of. Details: [`tide/README.md`](tide/README.md).

The images run `:latest`, so thresholds, budgets and prompts reach every consumer without an edit;
pin a digest when you need immutable bytes.

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
