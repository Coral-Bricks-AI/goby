# Merge gate and hosted-reviewer migration

## Contract

`Goby Review` answers **did the review run?** `Goby Gate` answers **has this
head satisfied the review policy?** Neither merges code or replaces CI.

The gate requires all ten facts:

1. A valid versioned receipt from a trusted Goby review author.
2. Receipt commit equals the current full head SHA.
3. Review completed without model-budget exhaustion or output truncation.
4. It was an agentic review, not the diff-only path.
5. No summary-only or over-cap findings remain.
6. GitHub thread pagination/data are complete.
7. Every expected inline finding has a published open/resolved thread for
   the reviewed head. Missing/deleted threads and 422 posting fallbacks fail.
8. There are no unresolved Goby threads, including older review rounds.
9. The latest `Goby Review` execution status succeeded, not pending/error.
10. The base ref and SHA-256 diff digest match the reviewed receipt. Retargeting
    or changing the diff requires a new review even if the head is unchanged.

All severities block. Inline thread resolution is a maintainer disposition,
not proof that code is correct. Missing facts fail closed. An oversized diff
has no complete receipt and cannot pass. Receipt fields are written by code,
not parsed from model claims about safety.

`src/core/rules.ts` defines the gate, turn budget, and review lifecycle with
`gdp-wired`. Production executes these compiled rules directly.
`tests-ts/prove.ts` kernel-checks 19 laws, and tests exercise all 1024 Boolean
gate inputs plus an unsafe completion-only mutant. This proves the rules,
**not** GitHub authorization, model accuracy, or external API freshness.

## Rechecking after fixes or discussion

A new commit or PR base edit triggers a new review. Receipts use schema 2;
old head-only receipts cannot grant eligibility. Resolving a thread without changing the
head can be rechecked without a model call:

```sh
goby gate --repo owner/name --pr 123 --expected-head <full-head-sha>
```

`mode: gate`, `pr-number`, and `expected-head` expose the same operation in
the action; no provider key is needed. Deleted threads are not resolutions.
Summary-only or capped findings require a fixed/new head and review; there is
no implicit "approve anyway" override. Old unstructured reviews cannot mint
new eligibility; they need a review with a current receipt.

## GitHub Actions handoff

Events generated with `GITHUB_TOKEN`, including commit statuses, generally
do not launch another Actions workflow. **Do not rely on a `status` trigger
for Goby's default token.**

Copy [the example gate workflow](../examples/workflows/goby-gate.yml), replace
`REVIEWED_COMMIT_SHA` with the same full Goby SHA as the review workflow, and
commit it to the default branch. It uses:

- `workflow_run` after **Goby review** completes, whether the job passes or
  is blocked;
- `workflow_dispatch` for a maintainer's no-model recheck;
- the run's PR number and PR-head SHA, not the possibly different merge SHA;
- current GitHub data, never downloaded artifacts or code from the PR;
- the default branch's trusted workflow and a pinned action;
- an expected-head check so an old run cannot green a newer commit.

The example **does not merge**. It publishes a current `Goby Gate` result.
Successful gate publication is followed by an evidence readback; a concurrent
change revokes that success instead of leaving a settled stale green. GitHub
commit statuses have no compare-and-swap API, so this is not an atomic lock:
serialize trusted automation and keep merge-time branch protection. Process
failure or a later mutation can still occur after a check.
A custom GitHub App token can also deliver status events, but requires its
own installation permissions and bot-login configuration.

## Safe merge integration

Use required checks and conversation protection. If a separate automation
merges, it must fail closed on unknown/pending checks and verify the same
head atomically. For example, after a successful gate recheck in a trusted
job, with `PR`, `HEAD_SHA`, and `GH_REPO` validated:

```sh
gh pr checks "$PR" --required --watch --fail-fast
gh pr merge "$PR" --squash --match-head-commit "$HEAD_SHA"
```

Do not use `--admin`, merge on `UNSTABLE`, or assume `CLEAN` by itself proves
that Goby ran. Set actual required checks first; the gate cannot compensate
for missing branch protection. Apply any additional approval policy too.
There remains a time-of-check race for discussion/CI state; GitHub branch
protection is the authoritative merge-time check. SHA matching prevents a
review for one commit from authorizing another.

Merges made with `GITHUB_TOKEN` do not launch normal push workflows. Preserve
an explicit `workflow_dispatch` deployment step where the existing repository
requires one (including Coralbricks web), or use an appropriately scoped App.

## Coralbricks rollout checklist

1. Land and review this Goby revision; pin its full SHA. No package publication
   is necessary. Use a dedicated CoralBricks inference credential.
2. Add the review workflow and optional gate handoff to a pilot repository.
   Initially keep Devin and disable automatic merging during the comparison.
3. Replay 10–20 labelled historical API/web PR heads. Measure missed known
   bugs, actionable new catches, false positives, latency, and inference cost.
4. Make `Goby Gate` and CI required. Verify error, skip, unresolved, stale,
   thread-resolution, and complete-clean cases in a sandbox PR.
5. Replace the Devin trigger in each consumer, not just its string. API's
   existing `--auto` path depends on repo settings; web's deploy dispatch
   must remain. Use current-head guards and no permissive merge-state shortcut.
6. Remove Devin only after the agreed quality bar is met. Keep a rollback path.

The default workflow deliberately skips forks because GitHub withholds its
secrets/write token there. A maintainer-controlled fork workflow must not
check out PR code. Context files currently come from the head and can contain
prompt injection; see [trust model](trust-model.md). Integration safety is not
an immunity claim for the model.
