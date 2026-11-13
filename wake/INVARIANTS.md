<!--
Passed verbatim to the goby-cleaners agent as its brief for this directory: the cleaner
scanning the reader. A bug here is code that makes one of these invariants false, or false under
some reachable input.

Read "What cannot be demonstrated here" before reporting anything. Most of this directory's
failure modes are GitHub API shapes and rate limits, and a claim about those cannot be
reproduced from inside a scan that has no token.
-->

# wake

Paths: `wake/**`, `src/wake/**`

The reader. Its defects do not make anything fail: they make a number **look better than it was**,
which is worse than a number that is missing. Every invariant here is about that asymmetry.

## Invariants

1. **A truncated read is never an empty one.** `notes` names every list that could not be read or
   was cut by `--limit`, and `threads_complete: false` marks a review whose findings are therefore
   a floor. Dropping either turns "I could not see" into "nothing happened", and a graph drawn over
   it is a claim nobody made. A source that fails is reported in `notes` and does not stop the
   other two.

2. **An absent measurement is null, never zero.** A run with no event stream reports
   `measured: false`; a price with no stated rate reports `cost.cents: null` and the reason; an
   unfinished workflow run reports `duration_s: null`. A stated zero is a measurement, and a
   consumer will average it.

3. **A dismissal is not a false positive.** A thread whose only reply argues back is `disputed`,
   never `ignored` and never "correctly no bug": the author of the change is not a neutral judge.
   `acted_on` requires a resolved thread, which is GitHub's own record of the author accepting it.

4. **The reader writes nothing.** No issue, comment, status or commit, and `wake/workflow.yml`
   grants no write scope. A tool that can change the repository it is measuring cannot be trusted
   with the measurement.

5. **The version on a record is the version that produced it.** `v` comes from the record's own
   marker or from `common/VERSION`, and is `null` when neither can name it. A guessed version puts
   a data point under a release that did not produce it, and the whole point of the axis is
   comparing releases.

6. **The record stays small.** Roughly a kilobyte for a review's run marker and under two for a
   review record: it is appended to a body people read, and the per-call trace it excludes is
   already in the log. `common/test_runrecord.py` and `tests-ts/record.test.ts` hold the bound.

## What cannot be demonstrated here

Anything about what a real repository's history contains. A scan has no token, so the GitHub
shapes this reads — `state_reason`, `isResolved`, `isOutdated`, a deleted branch's runs — are
asserted against fixtures and against one real repository on the pull request, not inside the
image.
