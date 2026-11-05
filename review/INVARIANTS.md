<!-- Passed verbatim to a goby cleaner as its brief for this directory.
     A defect here is code that makes one of these invariants false. -->

# review (the harness)

1. A review that cannot run says so, and never posts a green status. A missing key, an unreachable
   proxy, a clone that failed, an agent that exited without calling `report_findings` — each one
   resolves both statuses and exits non-zero. A pending status left behind blocks a pull request
   with nothing to read.
2. Nothing reaches the agent except what `review/entrypoint.sh` chooses. The agent runs as uid 10001
   under `env -i`; the GitHub token is a root-only file and the model key is behind the loopback
   proxy. Any variable added to that environment is a credential decision, not a convenience.
3. Every shell command has a wall clock and every review has a turn budget. `createBashTool(cwd,
   options)` takes the working directory first, pi's bash timeout is in **seconds**, and pi has no
   turn cap of its own — a mistake in any of the three turns a four-minute review into a fifteen
   minute hang. The numbers live in `review/defaults.env`, so a change there reaches every
   consumer through the image; a workflow only overrides one.
4. The diff the reviewer reads is `merge-base..head` for the commits GitHub names, not `base..head`.
   A base branch that moved on would otherwise appear as reversed changes in the review.
5. The receipt binds what the gate will re-read: GitHub's diff digest, the full head, the base ref.
   A receipt the gate can never match refuses every merge.

## Known-fragile areas

The shell, again: `entrypoint.sh` holds the clone, the sandbox copy, the uid drop and the proxy
lifecycle, and none of it is unit-tested — the failures it produces look like model errors.
Also fragile: the pid/uid/umask dance around the sandbox, and anything that assumes `:latest` is the
image the job is actually running.

## Known non-findings

- A review that finds nothing is a valid result; do not report the absence of findings as a defect.
- The model's own judgement of the code under review is out of scope: this brief is the harness.
