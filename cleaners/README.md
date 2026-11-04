# Goby cleaners

The post-merge half of goby. A push to `main` starts one hunter task; it reads the diff, hunts
every component that push touched, and files one GitHub issue per defect it could reproduce —
and prove goes away when the blamed line is changed.

Pre-merge review is the rest of this repo (`action.yml`): goby reads the pull request before it
merges, cleaners reads the default branch after. Same crew, different shift.

## Install

Both tiers run the same image and the same workflow file; they differ only in where the job
runs. `cleaners-post-merge.yml` ships with a `push` trigger, so copying it is enough.

### GitHub-hosted runner (default)

1. Copy `.github/workflows/cleaners-post-merge.yml` into your repo.
2. Add `CORALBRICKS_API_KEY` as a repository secret (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
   instead, with `model:` naming that provider).
3. Push to `main`.

No AWS account, no GitHub App, no service to deploy. What you cannot do here is reach a private
network: a hunt sees your code and nothing behind your firewall.

### Self-hosted runner

Same three steps, plus one:

1. Install a runner on a machine inside the network the hunts need to read.
2. Copy the workflow, and set `runs-on: [self-hosted, linux]` in it.
3. Add the model key secret, push.

Then a read-only database, a metrics service or an internal API is reachable, because the
container runs on that machine. This is the only difference between the tiers, and it is not a
code path — it is where the job runs.

### From another workflow

```yaml
jobs:
  hunt:
    uses: Coral-Bricks-AI/goby/.github/workflows/cleaners-post-merge.yml@<full sha>
    with:
      image: ghcr.io/coral-bricks-ai/goby-cleaners@sha256:...
      runs-on: ubuntu-latest
    secrets:
      CORALBRICKS_API_KEY: ${{ secrets.CORALBRICKS_API_KEY }}
```

Pin the image by digest. A tag is a moving handle, and findings are only comparable across
weeks if the container that produced them is the same one. `cleaners-image.yml` prints the
digest for every build.

## Components: a `HUNT.md` in the directory

A component is the directory that contains a `HUNT.md`. The file is the opt-in, so there is no
registry to keep in sync: no YAML, no generated JSON, no linter.

```markdown
<!-- Passed verbatim to the cleaners agent as its brief for this directory. -->
# <component>

1. <A property that must hold, stated so a violation is observable — not "the code is
   correct" but "no request is sent to a backend past its max_in_flight".>
2. <Another one. Three to six is the useful range.>

## Known-fragile areas
<Where the invariants are most likely to break. Optional; tells the hunter where to dig.>

## Known non-findings
- <date> · "<claim a hunter filed>" — <why it is not a defect> (#<issue>)
```

That file is the whole lever: phase 0 measured that "find bugs" produces style complaints and
confident false claims, while one stated invariant found a real 4× admission overshoot.
`Known non-findings` is the learning loop — close an issue as not-a-bug and add a line.

## What happens to a push

1. The workflow runs **one** container carrying `{repo, sha, before}`. No queue, no state: the
   event is the work, and the next push is the retry.
2. The container clones that sha shallow, fetches `before`, and makes a writable **sandbox**
   copy. The clone stays root-owned and read-only — the finding quotes it, the sandbox is where
   reproducers run.
3. `git diff --name-only before..after` → every `HUNT.md` directory it touches. When more than
   `MAX_COMPONENTS` (4) changed, the components with the most changed files go first and the
   log names the ones the cap dropped. No predecessor (new branch, forced push) → every
   component.
4. One pi process per component, with its own context and its own `MAX_TOOLS` budget.
5. Everything the hunter reports goes through `report_finding`, then through the filing gates.
   One issue per finding.

## The gates

Both are required fields in the tool schema, so a claim without them cannot be filed:

- **repro** — the command that made the defect happen, and the output it printed.
- **flip** — after changing the suspected line in the sandbox, the re-run that shows the defect
  is gone. This is what separates "a harness fails" from "this line causes it"; the phase-0
  false positive was a reproducer that patched out the very mechanism it blamed.

Then `post_findings.py`, in order: fingerprint already on an open **or closed** issue →
`issues_per_day` (a `high` finding is exempt) → create. The fingerprint is
`component | file basename | normalised title`, so a moved directory keeps its history.

## Models

`MODEL=provider/name` picks `models/<provider>.json`: `coral/…` (our gateway, the default),
`anthropic/…`, `openai/…`. `FALLBACK_MODEL` is used when the chosen provider has no key, and
again inside the hunt when its call fails — a rate limit or an exhausted key must not look like
a clean run.

A provider is usable when every **credential** its models file interpolates is set.
`CLEANERS_*` and `PI_*` are config this harness supplies, not credentials — `models/coral.json`
interpolates `CLEANERS_SESSION_ID` for spend attribution, and counting that as a credential
refused every default hunt. The agent's own shell sees only the one key its model needs.

## Giving the hunter better tools

The image is the extension point. Add a binary or a pi extension in your own image, then name
it from the workflow — no fork of this harness:

| input | what it does |
|---|---|
| `tools:` | `CLEANERS_TOOLS`, the whole `--tools` list. `report_finding` must remain in it. |
| `extensions:` | `CLEANERS_EXTENSIONS`, comma-separated pi extension files. `report_finding.ts` must remain in it. |
| `tool-key-env:` | `CLEANERS_TOOL_KEY_ENV`, comma-separated credential names a tool needs. |

The last one is a deliberate widening and is logged: `tool credentials: …` names every
credential handed to the hunt. Prefer a credential-free shim — a local socket held by root,
exposing only read-only statements — over an agent whose shell can open your database. Whatever
a tool can reach is reachable by whatever the model decides to run.

## What a hunt costs

`usage.py` prices each hunt from a model catalog, so the number is the table somebody actually
bills from rather than a guess. In Actions the line lands in the job summary, one per component:

```
- `gateway/dispatch` · coral/deepseek-v4.1-flash-fast · 7 turns · 42 tool calls · 95 s · 0 findings · $0.0213
```

The catalog is the first of `--models-json`, `$CLEANERS_MODELS_JSON`, a `.coral/models.json`
committed in the hunted repo, then `ml/platform/models.json` beside the checkout. Commit your
own rates if you want a number; without one the price reads `unknown`, never `0.0000` — a
printed zero reads as a measurement somebody made. The image deliberately carries no rates,
because a stale rate is a false measurement rather than a missing one.

## Run one locally

```bash
export GITHUB_TOKEN=...            # contents:read + issues:write
export CORALBRICKS_API_KEY=...     # or ANTHROPIC_API_KEY / OPENAI_API_KEY
docker build -t goby-cleaners cleaners
docker run --rm -e GITHUB_TOKEN -e CORALBRICKS_API_KEY \
  -e REPO=<owner>/<repo> -e SHA=$(git rev-parse HEAD) \
  -e BEFORE=$(git rev-parse HEAD~1) -e MODEL=coral/deepseek-v4.1-flash-fast \
  goby-cleaners
```

A single component, without the container, from a worktree you own:

```bash
export PI_CODING_AGENT_DIR=/tmp/pi-cleaners-agent
cp cleaners/models/coral.json "$PI_CODING_AGENT_DIR/models.json"
export PI_EXTENSION=$PWD/cleaners/report_finding.ts
export CLEANERS_JSON=1 CLEANERS_MAX_TOOLS=60 CLEANERS_SANDBOX=/tmp/sandbox
cp -a . /tmp/sandbox && rm -rf /tmp/sandbox/.git
bash cleaners/hunt.sh --repo-dir $PWD --component <component dir> \
  --sha $(git rev-parse --short HEAD) --before $(git rev-parse --short HEAD~1) \
  --charter <component dir>/HUNT.md \
  --model coral/deepseek-v4.1-flash-fast --out /tmp/hunt
python3 cleaners/usage.py /tmp/hunt
```

A run that reported nothing is a valid result: most components on most pushes are clean, and
`findings.jsonl` not existing is how that looks.

## Pieces

| file | role |
|---|---|
| `entrypoint.sh` | clone, sandbox, pick components, one hunt each, file |
| `hunt.sh` | one component: render the prompt, run pi read-only, collect findings |
| `prompt.md` | hunter prompt; `{{INVARIANTS}}` is the component's `HUNT.md` |
| `report_finding.ts` | emit tool (`outputSchema`, repro **and** flip required) + tool-call cap |
| `post_findings.py` | fingerprint, dedupe, `issues_per_day`, one issue per finding |
| `model_check.py` | which model this container can run, and its fallback |
| `plan.py` | which components a push touches, and collecting what the hunts found |
| `summarize_run.py`, `usage.py` | one log line per hunt; tokens and price, and the job summary |
| `models/*.json` | one provider file each: `coral` (our gateway), `anthropic`, `openai` |
| `../.github/workflows/cleaners-*.yml` | the image build and the reusable post-merge workflow |

## Traps worth remembering

**`--tools a,b,c` is a full replacement, extension tools included.** An allowlist that does not
name `report_finding` produces a hunter that cannot report: it finds the defect, writes it in
prose, and the prose is discarded. Four spike runs measured nothing because of this. The same
holds for `CLEANERS_EXTENSIONS`: a tool named in the list with no extension behind it is
declared to the model and cannot be called.

**pi has no turn cap, and a prompt asking for one is a suggestion.** The first unbudgeted run
went to 75 turns and 81 tool calls against a prompt that asked for 40. The budget is enforced in
`report_finding.ts` on `tool_call`, and the block message must tell the model to call the emit
tool — otherwise it stops and answers in prose.

**Shell holds only what cannot be a function.** Clone, `chown`/`chmod`, `runuser`, and the
loop. Everything that *decides* something — which model can run (`model_check.py`), which
components a push touches and which findings to collect (`plan.py`), whether a turn failed
(`summarize_run.py --status`), what may be filed (`post_findings.py`) — is Python with tests.
That split is not tidiness: the entrypoint's decisions were wrong in review twice, and shell
cannot be tested here.

**git refuses a repository owned by another user.** The reference tree is root-owned (that is
what makes its missing write bit mean anything), and the hunt runs as `hunter`, so git 2.35+
answers `fatal: detected dubious ownership` to everything — including the `git diff` the prompt
tells the hunter to start from. The entrypoint declares that one path safe system-wide, which
only lifts the ownership check; it grants no write.

**A required field in the tool schema is a real gate; a required field in the prompt is not.**
Phase 0: the repro fields turned a plausible false positive into a rejected claim.

**Silence must be distinguishable from success in both directions.** A missing credential is
checked before the clone (`model_check.py`), and a failed model call is caught after the run
(`summarize_run.py --status`): pi exits 0 either way, and both failure modes otherwise look like
a hunt that found nothing.

**`models/<provider>.json` fails hard on an unset `$VAR`.** That is why the entrypoint picks the
file by `MODEL`'s provider prefix and checks the variable is set before starting: a missing key
must fail in one log line, not after a clone. The same check is what lets a missing or dead
provider fall back to `FALLBACK_MODEL` instead of going silent.

**A hunt that could not think is not a hunt that found nothing.** `pi --mode json` exits 0 when
the model call fails, so the entrypoint greps the last assistant message for
`stopReason=error` and fails the job. Silence must never be indistinguishable from "no bugs".

## Filing limits by design

- One job per push. A cancelled or failed run means that push is not hunted; the next push is
  the retry.
- The token is the workflow's `GITHUB_TOKEN`, scoped to one repository with `contents: read` and
  `issues: write`. The entrypoint moves it to a root-only file and unsets it before the hunt
  starts, so the agent's environment never contains it.
- The model key is in the hunter's process, because the process that calls the model API has to
  hold a key for it. One key per hunt: only the selected provider's credential is passed.
- No runs table. Spend is attributable by session id (`hunt-…`) on the provider side.

## License

Apache-2.0. See [LICENSE](../LICENSE).
