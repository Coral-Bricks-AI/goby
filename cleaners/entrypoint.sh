#!/usr/bin/env bash
# The coral-cleaners task: one push, every component it touched, one issue per defect.
#
# Started by the webhook lambda with these overrides (see coral_cleaners/receiver):
#   REPO SHA BEFORE MODEL FALLBACK_MODEL MAX_TOOLS ISSUES_PER_DAY MAX_COMPONENTS
#   HUNTER_INDEX GITHUB_TOKEN CORALBRICKS_API_KEY
#
# A component is the directory that contains a HUNT.md. The push decides which ones are
# hunted: `git diff --name-only BEFORE..SHA`, intersected with those directories. When the
# push payload could not name its predecessor, the diff is unknown and every component is
# hunted (capped by MAX_COMPONENTS) — "we do not know what changed" is not "nothing did".
#
# Runs as root; each hunt runs as the unprivileged `hunter` user with an empty environment,
# so neither the token nor the Coral key is reachable from the agent: not in its env, not in
# a shell it spawns, and not readable from this process's /proc entry. A non-zero exit is
# visible as a failed task, and nothing retries it: the next push is the retry.
set -euo pipefail

: "${REPO:?}"; : "${SHA:?}"; : "${GITHUB_TOKEN:?}"
BEFORE="${BEFORE:-}"
MODEL="${MODEL:-coral/deepseek-v4.1-flash-fast}"
FALLBACK_MODEL="${FALLBACK_MODEL:-coral/deepseek-v4.1-flash-fast}"
MAX_TOOLS="${MAX_TOOLS:-60}"
ISSUES_PER_DAY="${ISSUES_PER_DAY:-3}"
MAX_COMPONENTS="${MAX_COMPONENTS:-4}"
HUNTER_INDEX="${HUNTER_INDEX:-0}"

WORK="${CLEANERS_WORK:-/workspace}"
REPO_DIR="$WORK/repo"
SANDBOX="$WORK/sandbox"
OUT="$WORK/out"

log() { printf '%s coral-cleaners %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
count_lines() { if [[ -f "$1" ]]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

# A provider is usable when every *credential* its models file interpolates is set. The
# check lives in model_check.py: it excludes the variables this harness supplies itself
# (CLEANERS_SESSION_ID is config, not a credential), and it is the one gate that decides
# whether the system does anything at all, so it is tested rather than written in shell.
MODELS_DIR=/opt/cleaners/models
if ! MODEL="$(python3 /opt/cleaners/model_check.py --models-dir "$MODELS_DIR" \
      --model "$MODEL" --fallback "$FALLBACK_MODEL")"; then
  log "error: nothing to hunt with"
  exit 2
fi
log "model $MODEL"

mkdir -p "$WORK"
rm -rf "$REPO_DIR" "$SANDBOX" "$OUT"
mkdir -p "$OUT"

# --- clone at the pushed commit ------------------------------------------------------
# Shallow: the hunter judges exactly the tree the push produced, plus the commit it came
# from so it can read the diff itself. The token is used here and by the filing step only;
# the agent's shell gets an allowlisted environment that excludes it.
#
# The token goes in a per-command header, never in the URL: a URL would be written into
# .git/config, which is inside the tree the hunter reads.
AUTH=(-c "http.extraHeader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
log "clone $REPO@$SHA"
git "${AUTH[@]}" -c advice.detachedHead=false clone --depth 1 --quiet \
  "https://github.com/${REPO}.git" "$REPO_DIR"
git -C "$REPO_DIR" remote set-url origin "https://github.com/${REPO}.git"
if ! git "${AUTH[@]}" -C "$REPO_DIR" fetch --depth 1 --quiet origin "$SHA"; then
  log "error: cannot fetch $SHA; refusing to hunt a different commit"
  exit 2
fi
if ! git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet "$SHA"; then
  log "error: cannot check out $SHA; refusing to hunt a different commit"
  exit 2
fi
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
log "at $HEAD_SHA"

# The predecessor: the diff, `git log` and `git blame` are the cheapest context a hunt has,
# and none of them work on a one-commit clone. A zero or absent sha means a new branch or a
# forced update, in which case there is no predecessor to name.
BEFORE_OK=0
if [[ "$BEFORE" =~ ^[0-9a-f]{40}$ && ! "$BEFORE" =~ ^0+$ ]] \
   && git "${AUTH[@]}" -C "$REPO_DIR" fetch --depth 1 --quiet origin "$BEFORE"; then
  BEFORE_OK=1
  log "predecessor $BEFORE"
else
  log "no predecessor; the clone has one commit and no diff"
fi

# The hunt runs as another uid, but it shares this container: keep the token off this
# process's environment entirely while the agent is working.
TOKEN_FILE=/root/.cleaners-token
# 077 protects the token file — and it used to leak into every later `mkdir`, so
# `/workspace/out/agent` came out root:700 and the hunt, running as `hunter`, could not
# even traverse into its own run directory: the first live hunt died in under a second
# with `mkdir: cannot create directory '/workspace/out/agent': Permission denied`.
umask 077
printf '%s' "$GITHUB_TOKEN" > "$TOKEN_FILE"
unset GITHUB_TOKEN
umask 022

# --- which components ----------------------------------------------------------------
# The file is the opt-in: a directory with a HUNT.md is hunted, a directory without one is
# not. There is no registry to drift from this, and moving a directory cannot orphan it.
# The selection itself lives in plan.py, because it decides whether a push is hunted at all
# and shell cannot be tested for that.
CHANGED_FILE="$OUT/changed.txt"
if [[ $BEFORE_OK -eq 1 ]]; then
  git -C "$REPO_DIR" diff --name-only "$BEFORE" "$HEAD_SHA" > "$CHANGED_FILE"
else
  # No predecessor: the prompt is told there is no diff rather than handed a file list it
  # cannot trust, and plan.py hunts every component instead of assuming nothing changed.
  printf '(the push did not name its predecessor, so there is no diff to read)\n' \
    > "$CHANGED_FILE"
fi

PLAN_ARGS=(--changed "$CHANGED_FILE" --max "$MAX_COMPONENTS" --sha "$SHA")
[[ $BEFORE_OK -eq 1 ]] || PLAN_ARGS+=(--before-unknown)
PICKED=()
while IFS= read -r dir; do
  [[ -n "$dir" ]] && PICKED+=("$dir")
done < <(git -C "$REPO_DIR" ls-files -- '*HUNT.md' \
          | python3 /opt/cleaners/plan.py picked "${PLAN_ARGS[@]}")
if [[ ${#PICKED[@]} -eq 0 ]]; then
  log "nothing to hunt"
  exit 0
fi
log "hunt [$HUNTER_INDEX] $(printf '%s ' "${PICKED[@]}")"

# --- the trees -----------------------------------------------------------------------
# `repo` is the reference the findings quote: root-owned and unwritable. `sandbox` is the
# same tree with its own `.git`, writable, which is what makes the flip gate possible — a
# reproducer is only evidence if it stops failing once the blamed line is patched. Keeping
# git in the sandbox means the hunter can patch, re-run, and `git checkout --` to undo it,
# while the reference stays exactly the commit that was pushed.
log "sandbox $SANDBOX"
mkdir -p "$SANDBOX"
cp -a "$REPO_DIR/." "$SANDBOX/"
chown -R hunter:hunter "$SANDBOX"

chown -R root:root "$REPO_DIR" "$OUT"
chmod -R a-w "$REPO_DIR"
# git 2.35+ refuses to read a repository whose owner is not the calling user, and this tree is
# root-owned on purpose: that is what makes the write bit meaningless for an agent that could
# otherwise `chmod` its way around it. Declared safe for this path only, for the whole system
# (the agent's uid cannot write /etc/gitconfig), so `git diff`, `git log` and `git blame` work
# from the hunt. Without it every git command in the checkout dies with "dubious ownership" and
# the primary context the prompt asks for is gone.
git config --system --add safe.directory "$REPO_DIR"
chmod 755 "$OUT"
chmod 0644 "$CHANGED_FILE"

RULES=()
if [[ -f "$REPO_DIR/AGENTS.md" ]]; then RULES=(--rules "$REPO_DIR/AGENTS.md"); fi

# --- one hunt ------------------------------------------------------------------------
# $1 component directory, $2 model, $3 run directory. Returns the hunt's exit status.
run_hunt() {
  local dir="$1" model="$2" agent_out="$3" provider="${2%%/*}" agent_home=/home/hunter/.pi-agent
  local status=0
  # `agent/` is created here, root-owned and traversable but not writable: it holds every
  # hunt's run directory, and nothing an agent runs may reach a sibling's findings. Only
  # the directory for the hunt in progress is handed to the agent.
  mkdir -p "$OUT/agent" "$agent_out" "$agent_home"
  chown root:root "$OUT/agent"
  chmod 755 "$OUT/agent"
  log "run dir $agent_out"
  # Every hunt starts from the pushed tree. A previous hunt leaves its flip patch applied
  # (that is what the gate asks it to do), plus a venv, scratch files and possibly a
  # half-edited module — and the retry would then review a tree nobody pushed.
  if [[ -d "$SANDBOX/.git" ]]; then
    if ! runuser -u hunter -- git -C "$SANDBOX" reset --hard --quiet "$HEAD_SHA" \
         || ! runuser -u hunter -- git -C "$SANDBOX" clean -xdffq; then
      log "warn: could not reset $SANDBOX before hunting $dir"
    fi
  fi
  # pi writes auth.json in its agent dir at startup even when the key comes from the
  # models file, so that dir has to belong to the agent. The image's copy of the config
  # stays root-owned and read-only; only the selected provider file is copied across.
  if [[ ! -f "$MODELS_DIR/$provider.json" ]]; then
    log "error: no $MODELS_DIR/$provider.json for $model"
    return 2
  fi
  cp "$MODELS_DIR/$provider.json" "$agent_home/models.json"
  chown -R hunter:hunter "$agent_out" "$agent_home"
  chmod 700 "$agent_home"

  # Only the credential this model actually uses is handed over: the agent's process holds
  # one key, never the full set, and its shell sees none of them (see report_finding.ts).
  local -a key_env=()
  case "$provider" in
    coral) key_env=(CORALBRICKS_API_KEY="$CORALBRICKS_API_KEY") ;;
    anthropic) key_env=(ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}") ;;
    openai) key_env=(OPENAI_API_KEY="${OPENAI_API_KEY:-}") ;;
    deepinfra) key_env=(DEEPINFRA_API_KEY="${DEEPINFRA_API_KEY:-}") ;;
    *) log "error: no credential name known for provider $provider"; return 2 ;;
  esac

  # Empty environment on purpose: nothing from this shell leaks into the agent's process.
  #
  # CLEANERS_TOOL_KEY_ENV names extra credentials a custom tool in the image needs. Every one
  # of them widens what the agent's shell can reach, so each is named in the log: a hunt that
  # can touch a database must not look like one that cannot. The rule stays that a tool should
  # reach the world through a credential-free shim; where that is impossible, this is done
  # visibly rather than by baking a secret into the image.
  local -a tool_env=()
  if [[ -n "${CLEANERS_TOOL_KEY_ENV:-}" ]]; then
    for name in ${CLEANERS_TOOL_KEY_ENV//,/ }; do
      if [[ -n "${!name:-}" ]]; then
        tool_env+=("$name=${!name}")
      else
        log "warn: CLEANERS_TOOL_KEY_ENV names $name, which is empty"
      fi
    done
    if [[ ${#tool_env[@]} -gt 0 ]]; then
      log "tool credentials: $(printf '%s\n' "${tool_env[@]}" | cut -d= -f1 | paste -sd, -)"
    fi
  fi

  set +e
  runuser -u hunter -- env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/home/hunter TMPDIR=/tmp \
    "${key_env[@]}" \
    ${tool_env[@]+"${tool_env[@]}"} \
    GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
    PI_CODING_AGENT_DIR="$agent_home" PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 \
    CLEANERS_JSON=1 CLEANERS_MAX_TOOLS="$MAX_TOOLS" \
    CLEANERS_COMPONENT="$dir" CLEANERS_OUT="$agent_out" \
    CLEANERS_SANDBOX="$SANDBOX" CLEANERS_SCRATCH="$agent_out/scratch" \
    bash /opt/cleaners/hunt.sh \
      --repo-dir "$REPO_DIR" --component "$dir" --sha "$HEAD_SHA" --before "$BEFORE" \
      --charter "$REPO_DIR/$dir/HUNT.md" --model "$model" --out "$agent_out" \
      --changed "$CHANGED_FILE" "${RULES[@]}" > "$OUT/agent.log" 2>&1
  status=$?
  set -e
  # Sealed the moment the hunt ends: the agent owns its run directory while it works, and
  # a later hunt must not be able to rewrite these findings before root files them.
  if ! chown -R root:root "$agent_out" || ! chmod -R a-w "$agent_out"; then
    log "warn: could not seal $agent_out"
  fi
  return "$status"
}

FAILED_HUNTS=0
# One heading, then a line per hunt. Written here rather than per hunt so a run that finds
# nothing still leaves a summary saying so.
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '## Coral Cleaners\n\n`%s@%s` · model `%s`\n\n' \
    "$REPO" "${HEAD_SHA:0:10}" "$MODEL" >> "$GITHUB_STEP_SUMMARY" \
    || log "warn: could not write the job summary header"
fi
for dir in "${PICKED[@]}"; do
  SLUG="$(echo "$dir" | tr '/' '_')"
  log "hunt $dir (model=$MODEL max_tools=$MAX_TOOLS)"
  status=0
  run_hunt "$dir" "$MODEL" "$OUT/agent/$SLUG" || status=$?
  log "hunt exit=$status events=$(count_lines "$OUT/agent/$SLUG/events.jsonl") findings=$(count_lines "$OUT/agent/$SLUG/findings.jsonl")"
  tail -20 "$OUT/agent.log" || true

  # What to do about this hunt is decided in plan.py, because it is a rule with five cases
  # and shell cannot be tested. `summarize_run.py --status` is the only thing that can say
  # the *model* failed: pi exits 0 with stopReason=error even on a 401 or a refused
  # connection, so the exit code never carries that information.
  model_failed=0
  python3 /opt/cleaners/summarize_run.py --status "$OUT/agent/$SLUG/events.jsonl" \
    || model_failed=1
  DECISION=$(python3 /opt/cleaners/plan.py classify --exit "$status" \
    --findings "$(count_lines "$OUT/agent/$SLUG/findings.jsonl")" \
    $([[ $model_failed -eq 1 ]] && echo --model-failed))

  case "$DECISION" in
    ok) model_error=0 ;;
    warn) model_error=0
          log "warn: model error after $dir emitted findings; filing those, not retrying" ;;
    retry) model_error=1 ;;
    wiring) log "error: $dir could not be hunted (exit $status: brief, provider or credential); not retried"
            FAILED_HUNTS=$((FAILED_HUNTS + 1)); continue ;;
    *) log "error: the hunt process failed for $dir (exit $status); not a model error, not retried"
       FAILED_HUNTS=$((FAILED_HUNTS + 1)); continue ;;
  esac

  # A retry is worth one run even on the same model: a rate limit or a dropped connection is
  # transient, and with MODEL == FALLBACK_MODEL (the shipped default) gating on inequality
  # meant a transient failure never retried at all.
  if [[ $model_error -eq 1 ]] \
     && python3 /opt/cleaners/model_check.py --models-dir "$MODELS_DIR" \
          --model "$FALLBACK_MODEL" --fallback "$FALLBACK_MODEL" > /dev/null 2>&1; then
    log "model error on $MODEL for $dir; retrying once on $FALLBACK_MODEL"
    status=0
    run_hunt "$dir" "$FALLBACK_MODEL" "$OUT/agent/$SLUG-retry" || status=$?
    log "retry exit=$status findings=$(count_lines "$OUT/agent/$SLUG-retry/findings.jsonl")"
    tail -20 "$OUT/agent.log" || true
    if [[ $status -ne 0 ]] || ! python3 /opt/cleaners/summarize_run.py --status \
         "$OUT/agent/$SLUG-retry/events.jsonl"; then
      log "error: the retry failed too; nothing filed from $dir"
      FAILED_HUNTS=$((FAILED_HUNTS + 1))
      continue
    fi
    model_error=0
  fi

  if [[ $model_error -eq 1 ]]; then
    log "error: the model call failed for $dir; nothing filed from it"
    FAILED_HUNTS=$((FAILED_HUNTS + 1))
    continue
  fi
  # A quiet run has to be attributable from the log alone: the event stream lives inside
  # the container, and "found nothing" is otherwise indistinguishable from "did not look".
  if [[ "$(count_lines "$OUT/agent/$SLUG/findings.jsonl")" -eq 0 && -s "$OUT/agent/$SLUG/events.jsonl" ]]; then
    python3 /opt/cleaners/summarize_run.py "$OUT/agent/$SLUG/events.jsonl" || true
  fi
  if [[ -f "$OUT/agent/$SLUG/run.json" ]]; then
    log "run $(tr -d '\n' < "$OUT/agent/$SLUG/run.json")"
  fi
  # The hunt's own price, where a user already looks. It goes to the log unconditionally,
  # because GITHUB_STEP_SUMMARY is set by Actions and absent everywhere else — and because a
  # container that cannot reach the summary file must still report what it spent.
  if [[ -f "$OUT/agent/$SLUG/events.jsonl" ]]; then
    summary_line="$(python3 /opt/cleaners/usage.py "$OUT/agent/$SLUG" --markdown || true)"
    if [[ -n "$summary_line" ]]; then
      log "usage ${summary_line#- }"
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] \
         && ! printf '%s\n' "$summary_line" >> "$GITHUB_STEP_SUMMARY"; then
        log "warn: could not write the job summary for $dir"
      fi
    fi
  fi
done

# --- file ----------------------------------------------------------------------------
FINDINGS="$(python3 /opt/cleaners/plan.py collect --agent-dir "$OUT/agent" \
  --out "$OUT/findings.jsonl")"
log "findings=$FINDINGS failed_hunts=$FAILED_HUNTS"

if [[ "$FINDINGS" -eq 0 ]]; then
  # Findings already emitted are still valid even if a later hunt errored, so only a run
  # with nothing to file is a failure. Silence must never be indistinguishable from "no
  # bugs", and a task that files nothing because the model had no credits is exactly that.
  if [[ $FAILED_HUNTS -gt 0 ]]; then
    log "error: $FAILED_HUNTS hunt(s) failed and nothing was filed"
    exit 3
  fi
  log "done (clean)"
  exit 0
fi
if [[ $FAILED_HUNTS -gt 0 ]]; then
  log "warn: filing despite $FAILED_HUNTS failed hunt(s)"
fi

GITHUB_TOKEN="$(cat "$TOKEN_FILE")"
rm -f "$TOKEN_FILE"
export GITHUB_TOKEN
log "file repo=$REPO sha=$HEAD_SHA issues_per_day=$ISSUES_PER_DAY"
set +e
python3 /opt/cleaners/post_findings.py \
  --findings "$OUT/findings.jsonl" --repo "$REPO" --sha "$HEAD_SHA" \
  --issues-per-day "$ISSUES_PER_DAY" | tee "$OUT/filed.json"
FILE_STATUS=${PIPESTATUS[0]}
set -e
if [[ $FILE_STATUS -ne 0 ]]; then
  log "error: filing failed (exit $FILE_STATUS); the findings are in $OUT/findings.jsonl"
  exit "$FILE_STATUS"
fi
log "done"
