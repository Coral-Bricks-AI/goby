<!-- Passed verbatim to a goby cleaner as its brief for this directory.
     A defect here is code that makes one of these invariants false. -->

# code (the harness)

1. **Never push outside the allowed paths without escalating first.** Every write this kind makes
   to a repository — the first commit and every fix-round commit — is scope-checked against
   `allowed_paths` (`src/core/scope.ts`'s `out_of_scope`) before a blob, a tree or a commit is
   created through the GitHub git-data API. A violation produces no branch and no pull request on
   the first round, and no fix commit on a later one; it posts an escalation and stops. An empty
   `allowed_paths` is not "anything goes" — `out_of_scope` fails closed, so nothing is in scope
   until a consumer names it.
2. **Never self-merge.** This kind opens a pull request and runs a capped thread-fix loop on it;
   nothing in `codeRun.ts` or `entrypoint.sh` merges, and no mode exists that would. A consumer
   without branch-protection auto-merge needs a separate mechanism — see `code/README.md`'s
   non-goals.
3. **Never exceed the round cap without escalating.** `GOBY_CODE_MAX_ROUNDS` bounds the review
   thread loop (`src/core/codePlan.ts`'s `round_decision`). Reaching it with threads still open is
   not a silent stop: the pull request is converted to a draft and an escalation comment is
   posted, naming how many threads were left. A thread the loop could not close must leave a
   record of why, not just disappear from the log when the container exits.
4. Nothing reaches the agent except what `code/entrypoint.sh` chooses, same split as
   `review/INVARIANTS.md` 2 — the agent runs as uid 10001 under `env -i`, the token is a root-only
   file, the model key is behind the loopback proxy. This kind is given `edit`/`write` in addition
   to `bash`/`read`/`grep`/`find`/`ls`/`report_done`, because changing the sandbox is the task; the
   harness never trusts what the agent *says* it changed, only what it reads back from the
   sandbox's working tree after the agent stops (`build_changes_manifest` in `entrypoint.sh`).
5. The commit, the branch and the pull request are all written through the git-data REST API by
   the root side of this container — never a local `git push` from inside the sandbox, and never
   from the agent's own uid. The scope check in invariant 1 is only as good as this: a path that
   could reach `git push` directly would let a violation leave the container before anything
   checked it.
6. Every shell command the agent runs has a wall clock, and so does the run as a whole — same
   reasoning as `review/INVARIANTS.md` 3, with its own budgets in `code/defaults.env`
   (`GOBY_AGENT_TIMEOUT_S` is higher here: this agent edits files and runs tests/builds to check
   its own work, not just reads them).
7. A run that cannot open a pull request says so and exits non-zero, same as a failed review
   cannot leave a pending status — see `codeRun.ts`'s `fail` mode and `entrypoint.sh`'s
   `goby_fail`. There is no pending GitHub status for `code/` to leave stuck, but there is a job
   that silently did nothing: a scope violation, a clone failure, an agent that never called
   `report_done`, all write to the log and to `GITHUB_STEP_SUMMARY` rather than exiting quietly.

## Known-fragile areas

The shell, again — same note as `review/INVARIANTS.md`'s: `entrypoint.sh` holds the clone, the
sandbox copy, the uid drop, the proxy lifecycle and the round loop, and none of it is
unit-tested beyond the pure pieces pulled into `src/core/codePlan.ts` and `src/core/scope.ts`.

## Known non-findings

- An empty diff with a clear summary of why the task could not be done in scope is a valid,
  honest result — not a defect in the agent or the harness.
- The model's own judgement of the task is out of scope for a cleaner reading this brief: this
  brief is the harness.
