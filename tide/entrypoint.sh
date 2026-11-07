#!/usr/bin/env bash
# The goby-tide task: one scheduled sweep, one issue per measured smell it can plan away.
#
# Started by the scheduled workflow as a container job, or by `docker run`, with these in the
# environment:
#   REPO SHA MODEL FALLBACK_MODEL GITHUB_TOKEN CORALBRICKS_API_KEY
# Budgets (TIDE_MAX_ITEMS, TIDE_MAX_TOOLS, TIDE_ISSUES_PER_DAY, and the three thresholds) default
# from /opt/tide/defaults.env; a same-named workflow variable overrides one.
#
# There is no diff here, and no push: this is the one goby product that looks at the whole
# repository on a clock. A detector measures the tree first — no model, no tokens, no opinion —
# and only the measurements over a threshold get an agent, which writes the plan and tries the
# refactor in a sandbox. `detect.py` owns what a smell is; `prompt.md` and `report_proposal.ts`
# own what a proposal must prove.
#
# Runs as root; each scan runs as the unprivileged `agent` user with an empty environment, so
# neither the token nor the Coral key is reachable from the agent. A non-zero exit is visible as
# a failed task, and nothing retries it: the next tick is the retry.
set -euo pipefail
# shellcheck source=/dev/null
source /opt/tide/defaults.env

: "${REPO:?}"; : "${SHA:?}"; : "${GITHUB_TOKEN:?}"
MODEL="${MODEL:-coral/deepseek-v4.1-flash-fast}"
FALLBACK_MODEL="${FALLBACK_MODEL:-coral/deepseek-v4.1-flash-fast}"

WORK="${TIDE_WORK:-/workspace}"
REPO_DIR="$WORK/repo"
SANDBOX="$WORK/sandbox"
OUT="$WORK/out"

log() { printf '%s goby-tide %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
count_lines() { if [[ -f "$1" ]]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

# `workflow_dispatch` can hand a numeric input the user left empty a value of `0`, and the
# defaults file's `:=` keeps it — `0` is not empty. A threshold of zero makes every file in the
# repository a candidate, and `git clone --depth 0` fails the clone outright, so the first manual
# run of a brand-new install can die before it measures anything. Anything that must be positive
# falls back to the image default and says so; the two knobs where `0` is a real choice
# (`TIDE_MAX_ITEMS`, `TIDE_ISSUES_PER_DAY`) keep it.
must_be_positive() {
  local name="$1" value="${!1}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    log "warn: $name=$value is not a positive integer; using the image default"
    unset "$name"
    # shellcheck source=/dev/null
    source /opt/tide/defaults.env
  fi
}
for knob in TIDE_MAX_FILE_LINES TIDE_MAX_TEST_FILE_LINES TIDE_MAX_DIR_FILES \
            TIDE_MAX_FILE_IMPORTS TIDE_MAX_TODOS TIDE_MAX_TODO_AGE_DAYS \
            TIDE_MAX_TOOLS TIDE_HISTORY_DEPTH; do
  must_be_positive "$knob"
done
# `0` is a real request here — "measure, pick nothing, still close what is gone" is how the
# `--close-gone` path was verified — so it is honoured rather than replaced. It is also the value a
# `workflow_dispatch` input can carry when the field was left blank, and a sweep that picks nothing
# must never look like a sweep that found nothing: say so in the one log line everybody reads.
if [[ "$TIDE_MAX_ITEMS" -eq 0 ]]; then
  log "warn: TIDE_MAX_ITEMS=0 — this sweep will pick no candidates and spend no model calls"
fi

# A provider is usable when every *credential* its models file interpolates is set. The check
# lives in common/model_check.py, because it decides whether the system does anything at all.
MODELS_DIR=/opt/tide/models
if ! MODEL="$(python3 /opt/common/model_check.py --models-dir "$MODELS_DIR" \
      --model "$MODEL" --fallback "$FALLBACK_MODEL")"; then
  log "error: nothing to scan with"
  exit 2
fi
log "model $MODEL"

mkdir -p "$WORK"
rm -rf "$REPO_DIR" "$SANDBOX" "$OUT"
mkdir -p "$OUT"

# --- clone at the default branch's commit --------------------------------------------
# Shallow and single-commit: a scheduled sweep judges the tree as it is, not a diff. The token is
# used here and by the filing step only; the agent's shell gets an allowlisted environment that
# excludes it.
#
# The token goes in a per-command header, never in the URL: a URL would be written into
# .git/config, which is inside the tree the sweep reads.
AUTH=(-c "http.extraHeader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
log "clone $REPO@$SHA"
# `TIDE_HISTORY_DEPTH` commits, not one: `todo_age` is a question about history, and a one-commit
# clone answers it with "0 days" for every line. The depth bounds the cost of a slow clone, which
# is the only thing it costs — the sweep is scheduled and nobody is waiting for it.
git "${AUTH[@]}" -c advice.detachedHead=false clone --depth "$TIDE_HISTORY_DEPTH" --quiet \
  "https://github.com/${REPO}.git" "$REPO_DIR"
git -C "$REPO_DIR" remote set-url origin "https://github.com/${REPO}.git"
# Same depth as the clone, or the fetch re-shallowens the tree to one commit and quietly takes
# `todo_age` away.
if ! git "${AUTH[@]}" -C "$REPO_DIR" fetch --depth "$TIDE_HISTORY_DEPTH" --quiet origin "$SHA" \
   || ! git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet "$SHA"; then
  log "error: cannot check out $SHA; refusing to sweep a different commit"
  exit 2
fi
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
log "at $HEAD_SHA"

# A repository may commit its own billed rates; the image carries none, because a stale rate is a
# false measurement rather than a missing one.
if [[ -z "${GOBY_MODELS_JSON:-}" && -f "$REPO_DIR/.goby/models.json" ]]; then
  export GOBY_MODELS_JSON="$REPO_DIR/.goby/models.json"
  log "pricing from .goby/models.json"
fi

# The sweep runs as another uid, but it shares this container: keep the token off this process's
# environment entirely while the agent is working.
TOKEN_FILE=/root/.tide-token
umask 077
printf '%s' "$GITHUB_TOKEN" > "$TOKEN_FILE"
unset GITHUB_TOKEN
umask 022

# --- measure -------------------------------------------------------------------------
# No model call yet. This is the cheap step, and it is also the one that decides whether the
# sweep has anything to do at all — a repository under every threshold costs a container start.
log "detect thresholds file_lines=$TIDE_MAX_FILE_LINES test_file_lines=$TIDE_MAX_TEST_FILE_LINES dir_files=$TIDE_MAX_DIR_FILES imports=$TIDE_MAX_FILE_IMPORTS todos=$TIDE_MAX_TODOS todo_age_days=$TIDE_MAX_TODO_AGE_DAYS history=$TIDE_HISTORY_DEPTH items=$TIDE_MAX_ITEMS"
set +e
python3 /opt/tide/detect.py scan --repo-dir "$REPO_DIR" --sha "$HEAD_SHA" \
  --config "$REPO_DIR/.goby/tide.json" \
  --out "$OUT/candidates.jsonl" --candidates "$OUT/picked.jsonl" \
  --max-items "$TIDE_MAX_ITEMS" \
  --max-file-lines "$TIDE_MAX_FILE_LINES" \
  --max-test-file-lines "$TIDE_MAX_TEST_FILE_LINES" \
  --max-dir-files "$TIDE_MAX_DIR_FILES" \
  --max-file-imports "$TIDE_MAX_FILE_IMPORTS" \
  --max-todos "$TIDE_MAX_TODOS" \
  --max-todo-age-days "$TIDE_MAX_TODO_AGE_DAYS" > "$OUT/plan.json"
DETECT_STATUS=$?
set -e
if [[ $DETECT_STATUS -ne 0 ]]; then
  # "the repository could not be measured" and "nothing is over the line" are opposite answers,
  # and the second one exits green. Swallowing the first turns the tide off silently.
  log "error: detect.py failed (exit $DETECT_STATUS); the sweep made no measurement"
  exit 2
fi
# The plan is the only place a repository's `known` decisions show up, and a silence nobody can
# read is what the list is supposed to avoid: the issues tell a reader to add an entry here, so
# the log says which entries were used and which have gone stale.
python3 - "$OUT/plan.json" > "$OUT/plan.txt" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
print(f'measured {plan["candidates"]} candidate(s), {len(plan["picked"])} picked, '
      f'{len(plan["suppressed"])} suppressed by .goby/tide.json, history {plan.get("history")}')
for candidate in plan["suppressed"]:
    print(f'  known: {candidate["check"]} {candidate["path"]} — {candidate["known_reason"]}')
for entry in plan["stale_known"]:
    print(f'  stale known entry, safe to delete: {entry["check"]} {entry["path"]}')
PY
while IFS= read -r line; do log "$line"; done < "$OUT/plan.txt"

# One facts file per picked candidate, and a TSV so bash can loop without parsing JSON.
python3 - "$OUT/picked.jsonl" "$OUT/candidates.jsonl" "$OUT/facts" "$OUT/picked.tsv" <<'PY'
import json, pathlib, re, sys
picked_path, all_path, facts_dir, tsv_path = map(pathlib.Path, sys.argv[1:5])
facts_dir.mkdir(parents=True, exist_ok=True)
rows = [json.loads(line) for line in picked_path.read_text().splitlines() if line.strip()]
lines = []
for row in rows:
    # The fingerprint is on the end because it is the one part that cannot collide: two paths can
    # sanitise to the same slug (`a b/c` and `a_b/c`), and two runs sharing a run directory would
    # seal each other out mid-scan.
    slug = (re.sub(r"[^A-Za-z0-9._-]+", "_", f"{row['check']}--{row['path']}").strip("_")[:100]
            + "--" + row["fingerprint"])
    (facts_dir / f"{slug}.json").write_text(json.dumps(row) + "\n")
    lines.append(f"{row['check']}\t{row['path']}\t{slug}")
tsv_path.write_text("".join(line + "\n" for line in lines))
print(f"{len(rows)} picked, {len(all_path.read_text().splitlines())} measured")
PY

# --- the trees -----------------------------------------------------------------------
# `repo` is the reference the measurement quotes: root-owned and unwritable. `sandbox` is the
# same tree with its own `.git`, writable, which is what makes the refactor checkable — the agent
# changes the sandbox, and the harness reads the change back with `git diff`.
log "sandbox $SANDBOX"
mkdir -p "$SANDBOX"
cp -a "$REPO_DIR/." "$SANDBOX/"
chown -R agent:agent "$SANDBOX"

chown -R root:root "$REPO_DIR" "$OUT"
chmod -R a-w "$REPO_DIR"
# git 2.35+ refuses a repository whose owner is not the calling user, and these trees are
# root-owned on purpose. Declared safe for these paths only: the agent's uid cannot write
# /etc/gitconfig.
git config --system --add safe.directory "$REPO_DIR"
git config --system --add safe.directory "$SANDBOX"
chmod 755 "$OUT"

RULES=()
if [[ -f "$REPO_DIR/AGENTS.md" ]]; then RULES=(--rules "$REPO_DIR/AGENTS.md"); fi

# --- one scan ------------------------------------------------------------------------
# $1 check, $2 path, $3 facts file, $4 slug, $5 model, $6 run directory. Returns the exit status.
run_scan() {
  local check="$1" path="$2" facts="$3" slug="$4" model="$5" agent_out="$6"
  local provider="${model%%/*}" agent_home=/home/agent/.pi-agent status=0
  # `agent/` is created here, root-owned and traversable but not writable: it holds every run's
  # output, and nothing an agent runs may reach a sibling's findings.
  mkdir -p "$OUT/agent" "$agent_out" "$agent_home"
  chown root:root "$OUT/agent"
  chmod 755 "$OUT/agent"
  log "run dir $agent_out"
  # Every scan starts from the swept tree. A previous scan leaves its refactor applied in the
  # sandbox (that is what the check asks it to do), plus a venv and scratch files — and the next
  # candidate would then be planned against a tree nobody committed.
  if [[ -d "$SANDBOX/.git" ]]; then
    if ! runuser -u agent -- git -C "$SANDBOX" reset --hard --quiet "$HEAD_SHA" \
         || ! runuser -u agent -- git -C "$SANDBOX" clean -xdffq; then
      log "warn: could not reset $SANDBOX before scanning $check on $path"
    fi
  fi
  # pi writes auth.json in its agent dir at startup even when the key comes from the models file,
  # so that dir has to belong to the agent. The image's copy stays root-owned and read-only; only
  # the selected provider file is copied across.
  if [[ ! -f "$MODELS_DIR/$provider.json" ]]; then
    log "error: no $MODELS_DIR/$provider.json for $model"
    return 2
  fi
  cp "$MODELS_DIR/$provider.json" "$agent_home/models.json"
  chown -R agent:agent "$agent_out" "$agent_home"
  chmod 700 "$agent_home"

  # Only the credential this model actually uses is handed over: the agent's process holds one
  # key, never the full set, and its shell sees none of them (see report_proposal.ts).
  local -a key_env=()
  case "$provider" in
    coral) key_env=(CORALBRICKS_API_KEY="$CORALBRICKS_API_KEY") ;;
    anthropic) key_env=(ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}") ;;
    openai) key_env=(OPENAI_API_KEY="${OPENAI_API_KEY:-}") ;;
    deepinfra) key_env=(DEEPINFRA_API_KEY="${DEEPINFRA_API_KEY:-}") ;;
    *) log "error: no credential name known for provider $provider"; return 2 ;;
  esac

  # Empty environment on purpose: nothing from this shell leaks into the agent's process. REPO
  # is on the list because the prompt renders it.
  set +e
  runuser -u agent -- env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/home/agent TMPDIR=/tmp \
    "${key_env[@]}" \
    GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
    PI_CODING_AGENT_DIR="$agent_home" PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 \
    TIDE_JSON=1 TIDE_MAX_TOOLS="$TIDE_MAX_TOOLS" \
    GOBY_SESSION_ID="tide-$slug-${HEAD_SHA:0:10}" \
    REPO="$REPO" \
    TIDE_OUT="$agent_out" TIDE_SANDBOX="$SANDBOX" TIDE_SCRATCH="$agent_out/scratch" \
    bash /opt/tide/tide.sh \
      --repo-dir "$REPO_DIR" --sandbox "$SANDBOX" \
      --check "$check" --path "$path" --facts "$facts" --sha "$HEAD_SHA" \
      --model "$model" --out "$agent_out" \
      --config "$REPO_DIR/.goby/tide.json" "${RULES[@]}" \
      > "$OUT/agent.log" 2>&1 < /dev/null
  status=$?
  set -e
  # The change the agent left behind is evidence, and it is read here rather than pasted by the
  # model: what a reviewer reads is what the after-run actually tested. `-N` stages new files
  # without running filters, so a refactor that adds a module shows up in the diff.
  if [[ -d "$SANDBOX/.git" ]]; then
    if ! runuser -u agent -- git -C "$SANDBOX" add -A > /dev/null 2>&1 \
       || ! runuser -u agent -- git -C "$SANDBOX" diff --cached --no-color \
            > "$agent_out/refactor.diff" 2>/dev/null; then
      log "warn: could not read the refactor diff for $check on $path"
      : > "$agent_out/refactor.diff"
    fi
  fi
  # Sealed the moment the scan ends: the agent owns its run directory while it works, and a later
  # scan must not be able to rewrite these proposals before root files them.
  if ! chown -R root:root "$agent_out" || ! chmod -R a-w "$agent_out"; then
    log "warn: could not seal $agent_out"
  fi
  return "$status"
}

FAILED_SCANS=0
# One heading, then a line per scan. Written here rather than per scan so a sweep that finds
# nothing still leaves a summary saying so.
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '## Goby tide\n\n`%s@%s` · model `%s`\n\n' \
    "$REPO" "${HEAD_SHA:0:10}" "$MODEL" >> "$GITHUB_STEP_SUMMARY" \
    || log "warn: could not write the job summary header"
fi

# An array, not a redirect on the loop. A child that reads stdin — `pi` does — used to eat the
# remaining rows, so the first candidate scanned and the rest were silently dropped while the
# sweep still reported `failed_scans=0`. Reading the rows first, and giving each child `/dev/null`,
# is what makes "picked N" and "scanned N" the same number.
mapfile -t ROWS < "$OUT/picked.tsv"
PICKED_COUNT=${#ROWS[@]}
SCANNED=0
for row in ${ROWS[@]+"${ROWS[@]}"}; do
  IFS=$'\t' read -r check path slug <<< "$row"
  [[ -n "${check:-}" ]] || continue
  SCANNED=$((SCANNED + 1))
  facts="$OUT/facts/$slug.json"
  log "scan $check on $path (model=$MODEL max_tools=$TIDE_MAX_TOOLS)"
  status=0
  run_scan "$check" "$path" "$facts" "$slug" "$MODEL" "$OUT/agent/$slug" || status=$?
  log "scan exit=$status events=$(count_lines "$OUT/agent/$slug/events.jsonl") proposals=$(count_lines "$OUT/agent/$slug/proposals.jsonl")"
  tail -20 "$OUT/agent.log" || true

  # `summarize_run.py --status` is the only thing that can say the *model* failed: pi exits 0
  # with stopReason=error even on a 401 or a refused connection.
  model_failed=0
  python3 /opt/common/summarize_run.py --status "$OUT/agent/$slug/events.jsonl" || model_failed=1
  CLASSIFY_ARGS=(--exit "$status"
                 --proposals "$(count_lines "$OUT/agent/$slug/proposals.jsonl")")
  [[ $model_failed -eq 1 ]] && CLASSIFY_ARGS+=(--model-failed)
  DECISION=$(python3 /opt/tide/collect.py classify "${CLASSIFY_ARGS[@]}")

  case "$DECISION" in
    ok) model_error=0 ;;
    warn) model_error=0
          log "warn: model error after $check emitted a proposal; filing it, not retrying" ;;
    retry) model_error=1 ;;
    wiring) log "error: $check could not be scanned (exit $status: facts, provider or credential); not retried"
            FAILED_SCANS=$((FAILED_SCANS + 1)); continue ;;
    *) log "error: the scan process failed for $check (exit $status); not a model error, not retried"
       FAILED_SCANS=$((FAILED_SCANS + 1)); continue ;;
  esac

  # A retry is worth one run even on the same model: a rate limit or a dropped connection is
  # transient, and with MODEL == FALLBACK_MODEL (the shipped default) gating on inequality meant
  # a transient failure never retried at all.
  if [[ $model_error -eq 1 ]] \
     && python3 /opt/common/model_check.py --models-dir "$MODELS_DIR" \
          --model "$FALLBACK_MODEL" --fallback "$FALLBACK_MODEL" > /dev/null 2>&1; then
    log "model error on $MODEL for $check; retrying once on $FALLBACK_MODEL"
    status=0
    run_scan "$check" "$path" "$facts" "$slug" "$FALLBACK_MODEL" "$OUT/agent/$slug-retry" || status=$?
    log "retry exit=$status proposals=$(count_lines "$OUT/agent/$slug-retry/proposals.jsonl")"
    tail -20 "$OUT/agent.log" || true
    if [[ $status -ne 0 ]] || ! python3 /opt/common/summarize_run.py --status \
         "$OUT/agent/$slug-retry/events.jsonl"; then
      log "error: the retry failed too; nothing filed for $check on $path"
      FAILED_SCANS=$((FAILED_SCANS + 1))
      continue
    fi
    model_error=0
  fi

  if [[ $model_error -eq 1 ]]; then
    log "error: the model call failed for $check; nothing filed for it"
    FAILED_SCANS=$((FAILED_SCANS + 1))
    continue
  fi
  # A quiet run has to be attributable from the log alone: the event stream lives inside the
  # container, and "found nothing" is otherwise indistinguishable from "did not look".
  if [[ "$(count_lines "$OUT/agent/$slug/proposals.jsonl")" -eq 0 && -s "$OUT/agent/$slug/events.jsonl" ]]; then
    python3 /opt/common/summarize_run.py "$OUT/agent/$slug/events.jsonl" || true
  fi
  if [[ -f "$OUT/agent/$slug/run.json" ]]; then
    log "run $(tr -d '\n' < "$OUT/agent/$slug/run.json")"
  fi
  # The scan's own price, where a user already looks. Unconditional in the log, because
  # GITHUB_STEP_SUMMARY is set by Actions and absent everywhere else.
  if [[ -f "$OUT/agent/$slug/events.jsonl" ]]; then
    summary_line="$(python3 /opt/common/usage.py "$OUT/agent/$slug" --markdown || true)"
    if [[ -n "$summary_line" ]]; then
      log "usage ${summary_line#- }"
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] \
         && ! printf '%s\n' "$summary_line" >> "$GITHUB_STEP_SUMMARY"; then
        log "warn: could not write the job summary for $check"
      fi
    fi
  fi
done

# Structural: it can only fire if this loop goes back to reading the file directly, which is the
# shape that lost candidates.
if [[ $SCANNED -ne $PICKED_COUNT ]]; then
  log "error: picked $PICKED_COUNT candidate(s) but scanned $SCANNED; that is not a sweep"
  exit 4
fi

# --- file ----------------------------------------------------------------------------
PROPOSALS="$(python3 /opt/tide/collect.py collect --agent-dir "$OUT/agent" \
  --candidates "$OUT/picked.jsonl" --out "$OUT/proposals.jsonl")"
log "proposals=$PROPOSALS failed_scans=$FAILED_SCANS"

GITHUB_TOKEN="$(cat "$TOKEN_FILE")"
rm -f "$TOKEN_FILE"
export GITHUB_TOKEN

# `--close-gone` only when the whole tree was measured. What decides "gone" is the measurement,
# not the model: a failed agent run costs a proposal, never a candidate, and a sweep whose model
# call failed still knows the file shrank. A failed *detection* is the opposite — it knows nothing,
# and closing on that would turn the sweep's own blindness into a "resolved" comment.
CLOSE=()
if [[ $DETECT_STATUS -eq 0 ]]; then CLOSE=(--close-gone); fi
log "file repo=$REPO sha=$HEAD_SHA issues_per_day=$TIDE_ISSUES_PER_DAY close_gone=${#CLOSE[@]}"
set +e
# The checks this sweep evaluated, not the ones that fired: `post_issues` closes an open issue only
# when the check behind it actually ran, so a sweep without history cannot close the `todo_age`
# issues it is unable to re-measure.
MEASURED="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["checks"]))' \
  "$OUT/plan.json")"
log "checks measured: $MEASURED"
python3 /opt/tide/post_issues.py \
  --proposals "$OUT/proposals.jsonl" --candidates "$OUT/candidates.jsonl" \
  --repo "$REPO" --sha "$HEAD_SHA" --measured-checks "$MEASURED" \
  --issues-per-day "$TIDE_ISSUES_PER_DAY" "${CLOSE[@]}" | tee "$OUT/filed.json"
FILE_STATUS=${PIPESTATUS[0]}
set -e
if [[ $FILE_STATUS -ne 0 ]]; then
  log "error: filing failed (exit $FILE_STATUS); the proposals are in $OUT/proposals.jsonl"
  exit "$FILE_STATUS"
fi

if [[ "$PROPOSALS" -eq 0 && $FAILED_SCANS -gt 0 ]]; then
  # Silence must never be indistinguishable from "no smells", and a task that files nothing
  # because the model had no credits is exactly that.
  log "error: $FAILED_SCANS scan(s) failed and nothing was filed"
  exit 3
fi
log "done"
