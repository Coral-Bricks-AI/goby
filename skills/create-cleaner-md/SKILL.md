---
name: create-cleaner-md
description: Write CLEANER.md briefs for a repo so goby cleaners can scan it — one file per component directory, each stating observable invariants. Use when adopting goby cleaners, or when a directory has no brief yet.
---

# Create CLEANER.md briefs

A component is a directory containing a `CLEANER.md`. That file is the cleaner's entire brief: it
is what makes it find your bugs instead of reporting style.

## What to do

1. Find components: directories with a coherent runtime property — a service, a dispatcher, a
   scheduler, a money path. Not every directory. Ten good briefs beat forty shallow ones.
2. For each, read the code enough to state **3-6 invariants** that must hold.
3. Write `<dir>/CLEANER.md` using the shape below.
4. Open one PR with all the files. They are reviewed by humans, and that review is the point.

## The shape

```markdown
<!-- Passed verbatim to the goby cleaners agent as its brief for this directory. -->
# <component>

1. <A property, stated so a violation is observable.>
2. <Another one.>

## Known-fragile areas
<Where these break most often, if you know. Optional.>

## Known non-findings
- <date> · "<claim>" — <why it is not a defect>
```

## The rule that decides whether this works

An invariant must be **observable**: a command exists whose output shows it false.

- Yes: "no request is sent to a backend past its `max_in_flight`."
- Yes: "a retried charge is issued once, never twice."
- No: "the code is correct." — This is what produced style complaints and one confident false
  claim in phase 0.
- No: "errors are handled." — Nothing can show it false.

One stated invariant ("no backend exceeds its max_in_flight") found a real 4× overshoot in the
same code where "find bugs" found nothing usable. Spend your effort on the sentence, not the
coverage.

## Where they come from

- Concurrency limits, queues, retries, idempotency keys.
- Money: who is charged, when, and what happens on a retry.
- Auth: what a request must carry, what it must never be able to do.
- State: what is written before what, and what is true if it stops halfway.
- Boundaries the module's own docstring names — those are stated intent, so drift is a defect.

Write invariants that already exist in the code or its docstrings. If you invent a property
the authors never intended, you get an issue about design, not a bug.

## Known non-findings

Every closed issue that was not a defect belongs here as one line. It is the loop: a claim
written down once stops being filed every week. Add them as issues close, not now.

## Do not

- Write a brief for a directory with no observable runtime property (config, types, docs).
- Restate the code. If the file can be regenerated from the implementation, it will be, and
  then it finds nothing.
- Include instructions to the cleaner about tools, budget or output — the harness owns those.
