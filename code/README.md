# Goby code

A general-purpose coding agent: give it a task and an allowed-path list, and it opens a branch,
a commit and a pull request for it — scoped so it can never touch a path you did not name. Same
sandboxed clone and key proxy as `review/` and `cleaners/`; what is new here is a diff-scope check
and a branch/commit/PR helper, since this is the one goby kind that writes code instead of just
reading it.

## Trigger: a reusable workflow, not a bespoke listener

`code/workflow.yml` is `workflow_call` — a consumer workflow calls it with `uses:`, rather than
copying it in as a top-level trigger the way `review/workflow.yml` is. That one choice covers both
shapes the issue asked for without goby building a `workflow_run` listener of its own:

- **React to an upstream job.** A consumer's own `workflow_run`-triggered workflow decides *when*
  to fire (a nightly build failed, a patch conflicted, whatever its own logic is) and calls this
  workflow with the task and scope that situation needs.
- **A human trigger.** A thin consumer-side wrapper with `on: workflow_dispatch` and the same two
  inputs (`task`, `allowed_paths`) calls this workflow directly; a person fills in the two fields
  from the Actions UI.

Either way, the logic that decides *when* to run lives in the consumer's own workflow, which is
exactly where a `workflow_run` trigger has to live — it reacts to one specific upstream workflow,
which only the consumer knows the name and the condition for. `code/` supplies the part that is
the same for everyone: given a task and a scope, do it safely.

## Install

1. Copy `code/workflow.yml` into `.github/workflows/` in your repository — unchanged, same as the
   other three kinds ship.
2. Add a workflow that calls it. For a `workflow_run` reaction:

   ```yaml
   name: Auto-fix on nightly failure
   on:
     workflow_run:
       workflows: ["Nightly build"]
       types: [completed]
   jobs:
     fix:
       if: github.event.workflow_run.conclusion == 'failure'
       uses: ./.github/workflows/goby-code.yml
       with:
         task: .goby/tasks/nightly-fix.md
         allowed_paths: "patches/**, .goby/tasks/**"
       secrets: inherit
   ```

   Or for a manual trigger:

   ```yaml
   name: Run a goby code task
   on:
     workflow_dispatch:
       inputs:
         task: { required: true, type: string }
         allowed_paths: { required: true, type: string }
   jobs:
     run:
       uses: ./.github/workflows/goby-code.yml
       with:
         task: ${{ inputs.task }}
         allowed_paths: ${{ inputs.allowed_paths }}
       secrets: inherit
   ```

3. Add `CORALBRICKS_API_KEY` as a repository secret (or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`,
   naming that provider in `GOBY_PROVIDER`/`GOBY_MODEL`). The caller workflow must pass it through
   with `secrets: inherit` (or an explicit `secrets:` block naming the same key) — `workflow_call`
   does not forward secrets on its own, and without this the run fails immediately with no key for
   the provider.

## Config a consumer supplies

- `task` — inline prompt text, or a path starting with `.goby/tasks/` (e.g.
  `.goby/tasks/nightly-fix.md`), read from the consumer repository at the commit this run started
  from. The prefix is the whole grammar (`src/core/codePlan.ts`'s `resolve_task_source`):
  anything else is used as inline text, verbatim.
- `allowed_paths` — a newline- or comma-separated glob list (`src/**`, `docs/*.md`, `a/**/b.ts`).
  **Empty means nothing is in scope** — the run refuses every change rather than guessing what you
  meant (`src/core/scope.ts`'s `out_of_scope`, fail closed).
- `base_ref` — which branch to start from and open the pull request against (defaults to `main`).

## What it does, in order

1. Clones `base_ref` at its current commit — the one clone this run's branch and pull request are
   both built from.
2. Resolves the task, runs the agent against a writable sandbox copy with a shell and `edit`/
   `write` tools (the one goby kind that gets them — see `code/prompt.md`).
3. Reads the sandbox's working-tree diff, and refuses it if any path falls outside
   `allowed_paths` — no branch, no pull request, just an escalation (a job summary note and a
   non-zero exit; see `code/INVARIANTS.md`).
4. Otherwise opens a branch, a commit and a pull request, all through the GitHub git-data API
   (`src/platforms/github.ts`) — never a local `git push` — so the scope check above is what the
   token can write, not a shell command that could race it.
5. Runs a capped review-thread loop (`GOBY_CODE_MAX_ROUNDS`, default 3): each round reads the pull
   request's open threads, gives the agent another pass to fix or explain each one, pushes a fix
   commit through the same git-data path if there is one, and replies + resolves every thread.
   Reaching the cap with threads still open leaves the pull request as a draft and posts why,
   rather than merging or dropping scope silently.

## Non-goals (v1, per the issue)

- **No self-merge.** This kind opens a pull request and resolves its own review threads; a
  consumer with branch-protection auto-merge (the first consumer, `coralbricks/www`) takes it from
  there. A consumer without auto-merge needs a human (or a separate mechanism) to merge — out of
  scope here, and noted rather than built speculatively.
- **No generic cross-kind agent-definition abstraction.** `code/` follows the same
  per-kind-directory pattern as `review/`, `cleaners/` and `tide/`; generalizing that pattern is a
  separate concern.
