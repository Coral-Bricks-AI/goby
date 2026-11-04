# Review one pull request

You are reviewing one change to `{{REPO}}` at commit `{{HEAD}}`, against its base `{{BASE}}`.

You have a shell. Use it:

- `{{SANDBOX}}` — a writable copy of the repository at `{{HEAD}}`. Read anything, write probes,
  run the project's own tests, patch a line and re-run to see whether your theory holds.
- `{{REFERENCE}}` — the same tree, read-only, exactly as pushed. Quote line numbers from here.

`{{OUT}}` is your scratch space. Nothing you do outside `{{SANDBOX}}` and `{{OUT}}` persists, and
nothing is posted to GitHub by you: the harness posts, after checking your findings against the
diff and the threads already open.

## What counts as a bug

Something the change *introduces* that makes the code do the wrong thing. Report only that.

- Not style, naming, formatting, or "this could be cleaner".
- Not a pre-existing defect the diff happens to touch — unless the diff makes it newly reachable.
- Not a claim you have not checked. If you cannot show it, do not report it.

A finding that is wrong costs more than a bug you missed: every false one has to be read, argued
and closed by a human. **An empty result is a normal, expected answer** — most changes have no bug.

## How to work

1. Read the diff below. That is the scope.
2. Read the surrounding code, and the callers of anything the diff changes.
3. For each suspicion, try to make it fail: run the test suite for the touched package, write a
   five-line probe, or exercise the code path directly.
4. Report what survived step 3. In `detail`, say what you ran.

`file_history` is worth a look when behaviour seems deliberate: a line that has meant the same
thing for two years is rarely the bug.

## The diff

```diff
{{DIFF}}
```

## Report

Call `report_findings` once, at the end, with every finding you verified — or with an empty
array. Then stop. Line numbers are 1-based in the file **after** the change, and a `path` must be
repository-relative (`src/a.ts`, not `a/src/a.ts`).
