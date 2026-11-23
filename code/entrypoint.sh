#!/usr/bin/env bash
# One code run: clone the base commit, hand a task to an agent in a sandbox, then — if its edits
# stay inside the allowed paths — open a branch, a commit and a pull request, and run a capped
# review-thread fix loop on it.
#
# Same split as review/entrypoint.sh: this shell runs as root and holds the token; the agent runs
# as uid 10001 with an empty environment, so neither the token nor the model key is reachable from
# the task's own code. The commit, the branch and the pull request are all written through the
# GitHub git-data API by this (root) side — never a local `git push` — so a scope violation is
# caught before anything leaves this process. See code/INVARIANTS.md.
#
# Inputs (environment, from the workflow):
#   GOBY_REPO GOBY_BASE_REF GOBY_TASK GOBY_ALLOWED_PATHS GITHUB_TOKEN
#   GOBY_PROVIDER GOBY_MODEL (optional; the image has a default)
#   CORALBRICKS_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY
# Budgets default from /opt/goby/defaults.env; a same-named workflow variable overrides one.
set -euo pipefail
# shellcheck source=/dev/null
source /opt/goby/lib.sh
# shellcheck source=/dev/null
source /opt/goby/defaults.env

missing=()
for name in GOBY_REPO GOBY_BASE_REF GOBY_TASK GOBY_ALLOWED_PATHS; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  goby_log "error: missing required input(s): ${missing[*]}"
  exit 2
fi

goby_fail() {
  goby_log "error: $1"
  GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_FAIL_REASON="$1" \
    node /opt/goby/codeRun.js fail || true
  exit 1
}

PROVIDER="${GOBY_PROVIDER:-coral}"
MODEL="${GOBY_MODEL:-deepseek-v4.1-flash-fast}"
WORK="${GOBY_WORK:-/workspace}"
REPO_DIR="$WORK/repo"
SANDBOX="$WORK/sandbox"
OUT="$WORK/out"
export GOBY_OUT="$OUT"
AGENT_HOME="/home/$GOBY_AGENT_USER/.pi-agent"

KEY_HEADER="authorization"; KEY_SCHEME="Bearer "
case "$PROVIDER" in
  coral)     KEY="${CORALBRICKS_API_KEY:-}"; UPSTREAM="https://inference.coralbricks.ai" ;;
  anthropic) KEY="${ANTHROPIC_API_KEY:-}";   UPSTREAM="https://api.anthropic.com"
             KEY_HEADER="x-api-key"; KEY_SCHEME="" ;;
  openai)    KEY="${OPENAI_API_KEY:-}";      UPSTREAM="https://api.openai.com" ;;
  *) goby_log "error: unknown provider $PROVIDER"; exit 2 ;;
esac
[[ -n "$KEY" ]] || { goby_log "error: no key for provider $PROVIDER"; exit 2; }

mkdir -p "$OUT" "$AGENT_HOME"

# SIGTERM handling mirrors review/entrypoint.sh: a run killed mid-way must not leave a pull
# request half-open with no comment on it. Before a pull request exists this is a silent exit (no
# status was ever posted, nothing was ever opened); after one exists it escalates.
on_cancel() {
  trap - EXIT TERM INT
  if [[ -f "$OUT/pr.json" ]]; then
    goby_log "error: cancelled; escalating the pull request this run opened"
    PR_NUM=$(python3 -c "import json;print(json.load(open('$OUT/pr.json'))['number'])" 2>/dev/null || echo "")
    if [[ -n "$PR_NUM" ]]; then
      GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
      GOBY_ESCALATION_REASON="cancelled before the fix loop finished" \
        node /opt/goby/codeRun.js escalate || true
    fi
  else
    goby_log "error: cancelled before a pull request was opened; nothing to resolve"
  fi
  goby_progress stop
  goby_proxy_stop
  exit 1
}
trap on_cancel TERM INT
goby_progress() { timeout 30 node /opt/goby/progress.js "$1" || true; }

# --- the base commit --------------------------------------------------------------------
rm -rf "${REPO_DIR:?}" "${SANDBOX:?}"; mkdir -p "$REPO_DIR" "$SANDBOX"
AUTH=(-c "http.extraHeader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
goby_log "clone $GOBY_REPO@$GOBY_BASE_REF"
if ! git "${AUTH[@]}" -c advice.detachedHead=false clone --quiet --depth 1 --branch "$GOBY_BASE_REF" \
  "https://github.com/${GOBY_REPO}.git" "$REPO_DIR"; then
  goby_fail "the clone of $GOBY_REPO@$GOBY_BASE_REF failed"
fi
git -C "$REPO_DIR" remote set-url origin "https://github.com/${GOBY_REPO}.git"
GOBY_BASE_SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
goby_log "base ${GOBY_BASE_SHA:0:10}"

# --- prepare: resolve the task and the allowed paths, name the branch --------------------
GOBY_REPO="$GOBY_REPO" GOBY_REPO_DIR="$REPO_DIR" GOBY_BASE_REF="$GOBY_BASE_REF" \
GOBY_BASE_SHA="$GOBY_BASE_SHA" GOBY_TASK="$GOBY_TASK" GOBY_ALLOWED_PATHS="$GOBY_ALLOWED_PATHS" \
GOBY_OUT="$OUT" GOBY_INSTANCE="${GOBY_INSTANCE:-}" \
  node /opt/goby/codeRun.js prepare | tee "$OUT/prepare.json"

TASK_TEXT=$(python3 -c "import json;print(json.load(open('$OUT/job.json'))['task_text'])")
ALLOWED_DISPLAY=$(python3 -c "import json;print('\n'.join(json.load(open('$OUT/job.json'))['allow_globs']) or '(none)')")

# --- secrets, then the agent's world -----------------------------------------------------
goby_key_to_file "$KEY"
goby_token_to_file
export GOBY_KEY_FILE GOBY_TOKEN_FILE
goby_proxy_start "$UPSTREAM" "$KEY_HEADER" "$KEY_SCHEME"
trap 'goby_progress stop; goby_proxy_stop' EXIT
goby_progress start

cp -a "$REPO_DIR/." "$SANDBOX/"
chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$SANDBOX"
chown -R root:root "$REPO_DIR" "$OUT"
chmod -R a-w "$REPO_DIR"
chmod 755 "$OUT"
git config --system --add safe.directory "$REPO_DIR"
git config --system --add safe.directory "$SANDBOX"

cp "/opt/goby/models/models.json" "$AGENT_HOME/models.json"
chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$AGENT_HOME"
chmod 700 "$AGENT_HOME"

GOBY_REPO="$GOBY_REPO" GOBY_BASE="$GOBY_BASE_SHA" GOBY_SANDBOX="$SANDBOX" GOBY_REFERENCE="$REPO_DIR" \
GOBY_PROMPT=/opt/goby/prompt.md GOBY_TASK_TEXT="$TASK_TEXT" GOBY_ALLOWED_DISPLAY="$ALLOWED_DISPLAY" \
GOBY_PROMPT_OUT="$OUT/prompt.md" python3 - <<'PYTEMPLATE'
import os, pathlib
template = pathlib.Path(os.environ["GOBY_PROMPT"]).read_text()
for key, value in {
    "{{REPO}}": os.environ["GOBY_REPO"],
    "{{BASE}}": os.environ["GOBY_BASE"],
    "{{SANDBOX}}": os.environ["GOBY_SANDBOX"],
    "{{REFERENCE}}": os.environ["GOBY_REFERENCE"],
    "{{OUT}}": os.environ["GOBY_OUT"],
    "{{TASK}}": os.environ["GOBY_TASK_TEXT"],
    "{{ALLOWED_PATHS}}": os.environ["GOBY_ALLOWED_DISPLAY"],
}.items():
    template = template.replace(key, value)
pathlib.Path(os.environ["GOBY_PROMPT_OUT"]).write_text(template)
PYTEMPLATE
chmod 644 "$OUT/prompt.md"

AGENT_OUT="$OUT/agent"
mkdir -p "$AGENT_OUT" "$AGENT_OUT/scratch"
chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$AGENT_OUT"
chmod 700 "$AGENT_OUT"

# Runs the agent once against $SANDBOX, with the given session id and prompt file; waits for it,
# backgrounded so the cancel trap stays reachable (same reasoning as review/entrypoint.sh). Leaves
# AGENT_STATUS / AGENT_ELAPSED set for the caller.
run_agent() {
  local session="$1" prompt_path="$2" budget="$3"
  cat > "$OUT/run-agent.sh" <<RUN
#!/usr/bin/env bash
set -euo pipefail
cd "$SANDBOX"
exec timeout --signal=TERM --kill-after=30 "$budget" \
  pi --mode json --model "$PROVIDER/$MODEL" --thinking "$GOBY_THINKING" \
  --no-session --no-extensions \
  --extension /opt/goby/report_done.ts \
  --tools bash,read,grep,find,ls,edit,write,report_done \
  "Read your brief at $prompt_path. It is the whole task. Do it, then call report_done." \
  > "$AGENT_OUT/events.jsonl" 2> "$AGENT_OUT/stderr.log"
RUN
  chmod 755 "$OUT/run-agent.sh"
  goby_log "code $GOBY_REPO model=$MODEL max_tool_calls=$GOBY_MAX_TOOL_CALLS agent_deadline=${budget}s session=$session"
  local started=$SECONDS
  set +e
  goby_run_as_agent \
    PI_CODING_AGENT_DIR="$AGENT_HOME" PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
    GOBY_MODEL_KEY=dummy-proxy-key GOBY_SESSION_ID="$session" \
    GOBY_AGENT_OUT="$AGENT_OUT" GOBY_OUT="$OUT" GOBY_SCRATCH="$AGENT_OUT/scratch" \
    GOBY_SANDBOX="$SANDBOX" GOBY_REPO="$GOBY_REPO" GOBY_BASE="$GOBY_BASE_SHA" \
    GOBY_MAX_TOOL_CALLS="$GOBY_MAX_TOOL_CALLS" GOBY_MAX_TURNS="$GOBY_MAX_TURNS" \
    GOBY_AGENT_TIMEOUT_S="$budget" GOBY_BASH_TIMEOUT_S="$GOBY_BASH_TIMEOUT_S" \
    bash "$OUT/run-agent.sh" &
  local pid=$!
  wait "$pid"
  AGENT_STATUS=$?
  AGENT_ELAPSED=$((SECONDS - started))
  set -e
  goby_log "agent session=$session exit=$AGENT_STATUS elapsed=${AGENT_ELAPSED}s"
}

# Builds $OUT/changes.json from the sandbox's working-tree diff against its own HEAD (the base
# commit it was cloned at, or — in a fix round — whatever the previous round left committed
# there). Deleted files carry a null content; everything else is read back as UTF-8 text, which is
# what the task prompt and this image's scope are both written for.
build_changes_manifest() {
  python3 - "$SANDBOX" "$OUT/changes.json" <<'PYSCRIPT'
import json, subprocess, sys, pathlib
sandbox, out = sys.argv[1], sys.argv[2]
status = subprocess.run(["git", "-C", sandbox, "diff", "--name-status", "--no-renames"],
                         capture_output=True, text=True, check=True).stdout
changes = []
for line in status.splitlines():
    if not line.strip():
        continue
    code, path = line.split("\t", 1)
    if code == "D":
        changes.append({"path": path, "content": None})
    else:
        changes.append({"path": path, "content": (pathlib.Path(sandbox) / path).read_text(errors="surrogateescape")})
# Untracked new files git diff does not show.
untracked = subprocess.run(["git", "-C", sandbox, "ls-files", "--others", "--exclude-standard"],
                            capture_output=True, text=True, check=True).stdout
for path in untracked.splitlines():
    if path.strip():
        changes.append({"path": path, "content": (pathlib.Path(sandbox) / path).read_text(errors="surrogateescape")})
pathlib.Path(out).write_text(json.dumps(changes))
print(len(changes))
PYSCRIPT
}

run_agent "code-$GOBY_BASE_SHA" "$OUT/prompt.md" "$GOBY_AGENT_TIMEOUT_S"

if [[ -s "$AGENT_OUT/events.jsonl" ]]; then
  SUMMARY_LINE="$(python3 /opt/common/summarize_run.py "$AGENT_OUT/events.jsonl" || true)"
  if [[ -n "$SUMMARY_LINE" ]]; then goby_log "$SUMMARY_LINE"; fi
fi
goby_log "agent exit=$AGENT_STATUS"

if ! grep -q '"kind":"done"' "$AGENT_OUT/done.jsonl" 2>/dev/null; then
  if [[ -f "$AGENT_OUT/stderr.log" ]]; then tail -20 "$AGENT_OUT/stderr.log"; fi
  goby_fail "the agent never called report_done (exit $AGENT_STATUS)"
fi
DONE_SUMMARY=$(python3 -c "
import json
for line in open('$AGENT_OUT/done.jsonl'):
    rec = json.loads(line)
    if rec.get('kind') == 'done':
        print(rec['summary'].replace('\n', ' ')[:300])
" 2>/dev/null || echo "Automated change")

CHANGED=$(build_changes_manifest)
goby_log "sandbox diff: $CHANGED file(s) changed"

goby_proxy_stop
set +e
GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
GOBY_CHANGES_FILE="$OUT/changes.json" GOBY_DONE_SUMMARY="$DONE_SUMMARY" \
  node /opt/goby/codeRun.js commit
COMMIT_STATUS=$?
set -e
if [[ "$COMMIT_STATUS" -eq 3 ]]; then
  goby_log "the agent made no in-scope change; nothing to open"
  exit 0
fi
if [[ "$COMMIT_STATUS" -eq 2 ]]; then
  goby_log "error: the change reached outside the allowed paths; refusing to open a pull request"
  if [[ -f "$OUT/escalation.md" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then cat "$OUT/escalation.md" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 1
fi
if [[ "$COMMIT_STATUS" -ne 0 ]]; then
  goby_fail "could not open the branch/commit/pull request (exit $COMMIT_STATUS)"
fi

PR_NUM=$(python3 -c "import json;print(json.load(open('$OUT/pr.json'))['number'])")
PR_URL=$(python3 -c "import json;print(json.load(open('$OUT/pr.json'))['html_url'])")
goby_log "opened pull request #$PR_NUM: $PR_URL"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf -- '- opened %s\n' "$PR_URL" >> "$GITHUB_STEP_SUMMARY"; fi

# --- the review-thread fix loop -----------------------------------------------------------
# Capped by GOBY_CODE_MAX_ROUNDS: each round reads the open threads on the pull request this run
# opened, and either stops (none left), continues (another round of fixes, under the cap), or
# escalates (the cap is reached with threads still open) — src/core/codePlan.ts round_decision.
ROUND=1
while :; do
  set +e
  GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
  GOBY_ROUND="$ROUND" GOBY_CODE_MAX_ROUNDS="$GOBY_CODE_MAX_ROUNDS" \
    node /opt/goby/codeRun.js threads
  THREADS_STATUS=$?
  set -e
  OPEN_COUNT=$(python3 -c "import json;print(len(json.load(open('$OUT/threads.json'))))" 2>/dev/null || echo 0)
  if [[ "$OPEN_COUNT" -eq 0 ]]; then
    goby_log "no open threads; done"
    break
  fi
  if [[ "$THREADS_STATUS" -eq 2 ]]; then
    goby_log "round cap reached with $OPEN_COUNT thread(s) open; escalating"
    GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
    GOBY_ESCALATION_REASON="$OPEN_COUNT review thread(s) remained open after $GOBY_CODE_MAX_ROUNDS round(s)." \
      node /opt/goby/codeRun.js escalate
    break
  fi

  # One more round: re-clone the branch at its current head, let the agent address the open
  # threads, diff, and either push a fix commit or reply with a reason — every thread, either way.
  rm -rf "${SANDBOX:?}"; mkdir -p "$SANDBOX"
  CURRENT_HEAD=$(python3 -c "import json;print(json.load(open('$OUT/pr.json'))['head_sha'])")
  git "${AUTH[@]}" -c advice.detachedHead=false clone --quiet "https://github.com/${GOBY_REPO}.git" "$SANDBOX" \
    || goby_fail "could not re-clone for round $ROUND"
  git -C "$SANDBOX" fetch --quiet origin "$CURRENT_HEAD"
  git -C "$SANDBOX" -c advice.detachedHead=false checkout --quiet "$CURRENT_HEAD"
  chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$SANDBOX"
  git config --system --add safe.directory "$SANDBOX"

  THREAD_TEXT=$(python3 -c "
import json
threads = json.load(open('$OUT/threads.json'))
for t in threads:
    print(f\"- {t.get('path')}:{t.get('line')}: {t.get('title')}\")
")
  cat > "$OUT/round-prompt.md" <<ROUNDPROMPT
# Address review feedback on $GOBY_REPO

The pull request you opened (branch \`$(python3 -c "import json;print(json.load(open('$OUT/job.json'))['branch'])")\`)
has open review comments:

$THREAD_TEXT

$SANDBOX is a writable clone at the pull request's current head. Fix what you agree with, within
the same allowed paths as before:

$ALLOWED_DISPLAY

Then call report_done with a summary describing, for each comment above, either what you changed
or why you are not changing it (a clear reason is a valid outcome). An empty diff with a summary
that explains why nothing needed to change is valid.
ROUNDPROMPT
  chmod 644 "$OUT/round-prompt.md"
  rm -f "$AGENT_OUT/done.jsonl" "$AGENT_OUT/events.jsonl"

  goby_key_to_file "$KEY"
  goby_proxy_start "$UPSTREAM" "$KEY_HEADER" "$KEY_SCHEME"
  run_agent "code-fix-$CURRENT_HEAD-r$ROUND" "$OUT/round-prompt.md" "$GOBY_AGENT_TIMEOUT_S"
  goby_proxy_stop

  ROUND_SUMMARY="(no summary)"
  if grep -q '"kind":"done"' "$AGENT_OUT/done.jsonl" 2>/dev/null; then
    ROUND_SUMMARY=$(python3 -c "
import json
for line in open('$AGENT_OUT/done.jsonl'):
    rec = json.loads(line)
    if rec.get('kind') == 'done':
        print(rec['summary'].replace('\n', ' ')[:500])
" 2>/dev/null || echo "(no summary)")
  fi

  CHANGED=$(build_changes_manifest)
  NEW_SHA=""
  if [[ "$CHANGED" -gt 0 ]]; then
    set +e
    GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
    GOBY_CHANGES_FILE="$OUT/changes.json" GOBY_DONE_SUMMARY="$ROUND_SUMMARY" \
      node /opt/goby/codeRun.js fix
    FIX_STATUS=$?
    set -e
    if [[ "$FIX_STATUS" -eq 2 ]]; then
      goby_log "a fix round reached outside the allowed paths; escalating without pushing it"
      GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
      GOBY_ESCALATION_REASON="a fix for round $ROUND would have touched paths outside the allowed list; it was not pushed." \
        node /opt/goby/codeRun.js escalate
      break
    fi
    if [[ "$FIX_STATUS" -eq 0 ]]; then
      NEW_SHA=$(python3 -c "import json;print(json.load(open('$OUT/pr.json'))['head_sha'])")
    fi
  fi

  THREAD_COUNT=$(python3 -c "import json;print(len(json.load(open('$OUT/threads.json'))))")
  for i in $(seq 0 $((THREAD_COUNT - 1))); do
    ROW=$(python3 -c "import json;t=json.load(open('$OUT/threads.json'))[$i];print(json.dumps(t))")
    THREAD_ID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['thread_id'])" "$ROW")
    COMMENT_ID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['comment_id'])" "$ROW")
    if [[ -n "$NEW_SHA" ]]; then
      NOTE="fixed in ${NEW_SHA:0:10}"
    else
      NOTE="$ROUND_SUMMARY"
    fi
    GOBY_REPO="$GOBY_REPO" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_PR="$PR_NUM" \
    GOBY_THREAD_ID="$THREAD_ID" GOBY_COMMENT_ID="$COMMENT_ID" GOBY_REPLY_NOTE="$NOTE" \
      node /opt/goby/codeRun.js reply || goby_log "warn: could not reply/resolve thread $THREAD_ID"
  done

  ROUND=$((ROUND + 1))
done

goby_log "code run complete for pull request #$PR_NUM"
