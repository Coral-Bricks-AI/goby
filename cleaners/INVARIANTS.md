<!--
Passed verbatim to the goby-cleaners agent as its brief for this directory: the cleaner
scanning itself. A bug here is code that makes one of these invariants false, or false under
some reachable input.

Read "What cannot be demonstrated here" before reporting anything. Most of this directory's
failure modes are uid, container or cloud interactions, and a claim about one of those cannot
be reproduced from inside the scan.
-->

# cleaners

Paths: `cleaners/**`

This is the cleaner. Its defects do not make a scan fail — they make it **file nothing**, or
file something false, which is the failure the whole design exists to prevent. A defect in
the *gate* is therefore the most valuable finding this component can produce.

## Invariants

1. **A scan that cannot think is never a clean scan.** `pi --mode json` exits 0 even when the
   model call fails (measured on a 401 and on a refused connection: exit 0,
   `stopReason=error`), so nothing may infer success from an exit code. `summarize_run.py
   --status` reads the last assistant message; `plan.py:classify` turns that plus the exit
   status and the finding count into `ok`/`warn`/`retry`/`wiring`/`harness`; a task that filed
   nothing while any scan failed exits non-zero. No path may reach `done (clean)` after a
   failed model call, and no path may report "no bugs" when the truth is "no tokens".

2. **Nothing is filed without both runs.** `report_finding` rejects a finding whose
   `repro_command`/`repro_output` or `flip_command`/`flip_output` is empty, in the tool's own
   `execute`, not in the prompt. `post_findings.py` files only what arrived through it, and
   refuses a record that does not name its component. A claim that could not be made to fail,
   then made to stop failing, is not a finding and must not be able to become an issue.

3. **A finding is filed at most once, and the cap never hides a real one.** The fingerprint is
   component + file basename + normalised title, checked against issues labelled
   `goby-cleaners` in any state — a closed "not a bug" is an answer that must not be asked
   again. `issues_per_day` bounds the rest and exempts `high`. In particular: a finding
   skipped by the cap must not mark the batch as filed, or the `high` finding that follows it
   with the same fingerprint is suppressed by something no human ever saw.

4. **A component is a directory that holds an `INVARIANTS.md`.** `plan.py:components` strips the
   suffix, drops a root-level `INVARIANTS.md` (that would mean "scan the whole repo") and reports
   anything shaped otherwise; `picked` matches changed paths with a separator-aware prefix
   (`a/b` does not contain `a/bc/x`) and orders what it found by how many changed files landed
   in each component, ties broken by a hash of the commit and that change set — so the cap drops
   the component this push moved least, the same commit always scans the same set, and two pushes
   over the same paths do not drop the same component forever; an unknown change set
   means every component, capped by `MAX_COMPONENTS`, because "we do not know what changed" is
   not "nothing did".

5. **The credential that is used is the one that exists.** `model_check.py` treats only
   non-harness variables as credentials — `CLEANERS_*` and `PI_*` are config the harness
   supplies, and counting one as a credential refused every default scan once. A provider
   whose key is absent must fall back before the clone, not die after it; the task receives
   only the selected provider's key plus the fallback's, and the agent's own process receives
   only the one its scan uses.

6. **The agent can read nothing secret and reach no sibling's output.** The `bash` tool's
   environment is an allowlist, not a denylist, and never includes a token or a key. The
   reference clone is root-owned and unwritable, and declared safe for git — otherwise every
   `git diff` the prompt asks for fails with "dubious ownership". `agent/` is root-owned, only
   the run directory in progress is chowned to the agent, and it is sealed the moment the scan
   returns, so a component whose code the agent executes cannot rewrite an earlier
   component's findings. The umask that protects the token file must not survive into the
   `mkdir` that creates those directories.

7. **The workflow supplies the trigger and nothing else.** `.github/workflows/cleaners-post-merge.yml`
   passes `{repo, sha, before}`, the model choice, and any explicit budget override, and its
   `permissions:` block is the whole grant: `contents: read` and `issues: write`, nothing wider.
   There is no receiver, no signature to verify and no token to mint — the job's own
   `GITHUB_TOKEN` is the token. A defect here looks like a scan of the wrong commit, or a job
   holding a permission it does not need, and neither is visible from a finding.

The three numeric defaults — `MAX_TOOLS`, `ISSUES_PER_DAY`, `MAX_COMPONENTS` — live in
`cleaners/defaults.env`. A workflow only overrides one, so a change there reaches every client
through `:latest`; a numeric fallback in the entrypoint or the workflow is the duplication this
rule exists to prevent.

## Known-fragile areas

The shell: every control-flow bug found so far has been in `entrypoint.sh` or `cleaner.sh`, and
none of it is unit-tested — if a decision can be a function in `plan.py`, a helper in
`model_check.py` or a field in the tool schema, it belongs there instead. Also fragile: uid and
umask interactions between root and `cleaner`; the order of dedupe, batch recording and budget;
the provider/fallback paths, which have two directions each; and anything that assumes the
gate reduces to "the command failed".

## What cannot be demonstrated here, and must not be reported as a finding

The scan runs as an unprivileged user in a container with no cloud credentials and no GitHub
token in its shell. Each of these is a claim you cannot make fail, so do not make it:

- anything requiring root, `runuser`, `chown`/`chmod`, `umask`, or a second uid;
- the image build and its GHCR publish (`cleaners-image.yml`), image digests, or `runs-on`;
- the reusable workflow's inputs, secrets wiring, and what `github.event.before` carries;
- the runner's mount of `$GITHUB_STEP_SUMMARY`, or the Actions log itself.

Those paths are covered by unit tests, by the container-level checks in CI, or by reading —
not by you. What you *can* prove here is the pure logic: `plan.py`, `model_check.py`,
`post_findings.py`, the `report_finding` schema, and the prompt rendering in `cleaner.sh`.

## Known non-findings

<!-- Closed as not-a-bug. One line each: date, the claim, and why it is not a defect. -->
- 2026-11-06 · "Two findings titled in a non-Latin script share a fingerprint, so the second is
  filed as already filed" — accepted. Normalising the title keeps ASCII letters and digits, and
  our findings are titled in English; keeping the script changed the fingerprint of every accented
  title already filed, which re-files issues a human has already answered. A non-Latin title needs
  an English one (#73, #77, #78, #80).
