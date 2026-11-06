#!/usr/bin/env bash
# One review: clone the change, hand it to an agent in a sandbox, then publish what it proved.
#
# Runs as root so it can hold the token and the model key. The agent runs as uid 10001 with an
# empty environment, so neither secret is reachable from the code being reviewed — that split is
# the reason a review can clone and run a pull request at all.
#
# Inputs (environment, from the workflow):
#   GOBY_REPO GOBY_PR GOBY_HEAD GOBY_BASE GITHUB_TOKEN
#   GOBY_PROVIDER GOBY_MODEL (optional; the image has a default)
#   CORALBRICKS_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY
# Budgets default from /opt/goby/defaults.env; a same-named workflow variable overrides one.
set -euo pipefail
# shellcheck source=/dev/null
source /opt/goby/lib.sh
# shellcheck source=/dev/null
source /opt/goby/defaults.env

# Gate mode rechecks eligibility only: no clone, no model, no key. It answers "is the evidence on
# this pull request still sufficient", which is what a workflow_run handoff needs.
if [[ "${GOBY_MODE:-review}" == "gate" ]]; then
  : "${GOBY_REPO:-}"; : "${GITHUB_TOKEN:-}"
  if [[ -z "$GOBY_REPO" || -z "$GITHUB_TOKEN" ]]; then
    goby_log "error: gate mode needs GOBY_REPO and GITHUB_TOKEN"
    exit 2
  fi
  GOBY_OUT="${GOBY_OUT:-/workspace/out}" GOBY_EVENT_FILE="${GOBY_EVENT_FILE:-}" \
  GITHUB_EVENT_NAME="${GITHUB_EVENT_NAME:-}" GOBY_PR="${GOBY_PR:-}" GOBY_HEAD="${GOBY_HEAD:-}" \
    node /opt/goby/reviewRun.js gate
  exit $?
fi

# Named, not a bare `${var:?}`: the point of this check is that whoever wired the job can read
# which input is missing without opening the script.
missing=()
for name in GOBY_REPO GOBY_PR GOBY_HEAD GOBY_BASE; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  goby_log "error: missing required input(s): ${missing[*]}"
  exit 2
fi

# Cosmetic only (src/progress.ts): a "Goby is reviewing" note on the pull request, deleted on every
# exit. Wall-clocked and `|| true`, so it can neither hang a review nor change how one ends.
goby_progress() { timeout 30 node /opt/goby/progress.js "$1" || true; }
goby_progress start
trap 'goby_progress stop' EXIT
PROVIDER="${GOBY_PROVIDER:-coral}"
MODEL="${GOBY_MODEL:-deepseek-v4.1-flash-fast}"
MAX_DIFF_LINES="$GOBY_MAX_DIFF_LINES"
WORK="${GOBY_WORK:-/workspace}"
REPO_DIR="$WORK/repo"
SANDBOX="$WORK/sandbox"
OUT="$WORK/out"
export GOBY_OUT="$OUT"
AGENT_HOME="/home/$GOBY_AGENT_USER/.pi-agent"

case "$PROVIDER" in
  coral)     KEY="${CORALBRICKS_API_KEY:-}"; UPSTREAM="https://inference.coralbricks.ai" ;;
  anthropic) KEY="${ANTHROPIC_API_KEY:-}";   UPSTREAM="https://api.anthropic.com" ;;
  openai)    KEY="${OPENAI_API_KEY:-}";      UPSTREAM="https://api.openai.com" ;;
  *) goby_log "error: unknown provider $PROVIDER"; exit 2 ;;
esac
[[ -n "$KEY" ]] || { goby_log "error: no key for provider $PROVIDER"; exit 2; }

mkdir -p "$OUT" "$SANDBOX" "$AGENT_HOME"
rm -rf "${REPO_DIR:?}" "${SANDBOX:?}"; mkdir -p "$REPO_DIR" "$SANDBOX"

# --- the change -------------------------------------------------------------------------
# AUTH goes in a per-command header, never the URL: a URL lands in .git/config inside the tree the
# reviewer reads, and the sandbox copy would carry it. Not a partial clone either: a blobless clone
# fetches blobs lazily, and that lazy fetch would go out unauthenticated from inside the sandbox.
AUTH=(-c "http.extraHeader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
goby_log "clone $GOBY_REPO@${GOBY_HEAD:0:10} (base ${GOBY_BASE:0:10})"
git "${AUTH[@]}" -c advice.detachedHead=false clone --quiet --no-checkout \
  "https://github.com/${GOBY_REPO}.git" "$REPO_DIR"
git -C "$REPO_DIR" remote set-url origin "https://github.com/${GOBY_REPO}.git"
# The merge base comes from GitHub, so three commits at depth 1 are enough: the head, the base the
# pull request was opened against, and the commit the diff is actually taken from. Guessing a depth
# of history means either fetching far more than needed or discovering, on a quiet day, that the
# merge base was never downloaded and the diff is against the wrong thing.
MERGE_BASE=""
if MERGE_BASE=$(GOBY_REPO="$GOBY_REPO" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
     GITHUB_TOKEN="$GITHUB_TOKEN" node /opt/goby/reviewRun.js merge-base 2>/dev/null); then
  goby_log "merge base ${MERGE_BASE:0:10}"
else
  # A compare that fails (an enormous range, a transient error) is not a reason to review nothing:
  # fall back to the base commit, which is what a two-dot diff uses anyway.
  MERGE_BASE="$GOBY_BASE"
  goby_log "warn: no merge base from the API; diffing against the base commit"
fi
if ! git "${AUTH[@]}" -C "$REPO_DIR" fetch --quiet --depth 1 origin "$GOBY_HEAD" "$MERGE_BASE"; then
  goby_log "error: cannot fetch $GOBY_HEAD/$MERGE_BASE; refusing to review a different commit"
  exit 2
fi
if [[ "$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" != "$GOBY_HEAD" ]] \
   && ! git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet "$GOBY_HEAD"; then
  goby_log "error: checkout of $GOBY_HEAD failed; refusing to review a different commit"
  exit 2
fi

DIFF="$OUT/diff.patch"
git -C "$REPO_DIR" diff --find-renames "$MERGE_BASE" "$GOBY_HEAD" > "$DIFF"
goby_log "diff merge-base..head (${MERGE_BASE:0:10}..${GOBY_HEAD:0:10})"
DIFF_LINES=$(wc -l < "$DIFF" | tr -d ' ')
goby_log "diff $DIFF_LINES lines"
if [[ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]]; then
  # Skipping is a verdict, not a crash: the review says so, and the gate fails closed.
  goby_log "skipped: diff is $DIFF_LINES lines (cap $MAX_DIFF_LINES)"
  GOBY_REPO="$GOBY_REPO" GOBY_PR="$GOBY_PR" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
  GOBY_MODEL="$MODEL" GOBY_SKIP_REASON="diff is $DIFF_LINES lines (cap $MAX_DIFF_LINES)" \
    node /opt/goby/reviewRun.js skip || true
  exit 0
fi

# --- secrets, then the agent's world -----------------------------------------------------
goby_key_to_file "$KEY"
goby_token_to_file
export GOBY_KEY_FILE GOBY_TOKEN_FILE
goby_proxy_start "$UPSTREAM"
# Replaces the trap above, so it keeps the progress cleanup; that one goes first as it cannot fail.
trap 'goby_progress stop; goby_proxy_stop' EXIT

# Prepare talks to GitHub, so it runs before the drop and while the token is in this process.
GOBY_REPO="$GOBY_REPO" GOBY_PR="$GOBY_PR" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
GOBY_MODEL="$MODEL" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
GOBY_GATE="${GOBY_GATE:-off}" \
  node /opt/goby/reviewRun.js prepare | tee "$OUT/prepare.json"

if grep -q '"reuse":true' "$OUT/prepare.json"; then
  goby_log "this head was already reviewed; refreshing the gate only"
  GOBY_REPO="$GOBY_REPO" GOBY_PR="$GOBY_PR" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
  GOBY_MODEL="$MODEL" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" \
    node /opt/goby/reviewRun.js finish
  exit $?
fi

# The reference tree is what findings quote; the sandbox is what the reviewer may change.
cp -a "$REPO_DIR/." "$SANDBOX/"
chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$SANDBOX"
chown -R root:root "$REPO_DIR" "$OUT"
chmod -R a-w "$REPO_DIR"
chmod 755 "$OUT"
# git 2.35+ refuses a repository owned by another user, and this tree is root-owned on purpose.
git config --system --add safe.directory "$REPO_DIR"

cp "/opt/goby/models/models.json" "$AGENT_HOME/models.json"
chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$AGENT_HOME"
chmod 700 "$AGENT_HOME"

GOBY_REPO="$GOBY_REPO" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
GOBY_SANDBOX="$SANDBOX" GOBY_REFERENCE="$REPO_DIR" GOBY_PROMPT=/opt/goby/prompt.md GOBY_DIFF="$DIFF" \
GOBY_PROMPT_OUT="$OUT/prompt.md" python3 - <<'PYTEMPLATE'
import os, pathlib
template = pathlib.Path(os.environ["GOBY_PROMPT"]).read_text()
diff = pathlib.Path(os.environ["GOBY_DIFF"]).read_text()
for key, value in {
    "{{REPO}}": os.environ["GOBY_REPO"],
    "{{HEAD}}": os.environ["GOBY_HEAD"],
    "{{BASE}}": os.environ["GOBY_BASE"],
    "{{SANDBOX}}": os.environ["GOBY_SANDBOX"],
    "{{REFERENCE}}": os.environ["GOBY_REFERENCE"],
    "{{OUT}}": os.environ["GOBY_OUT"],
    "{{DIFF}}": diff,
}.items():
    template = template.replace(key, value)
pathlib.Path(os.environ["GOBY_PROMPT_OUT"]).write_text(template)
PYTEMPLATE
chmod 644 "$OUT/prompt.md"

AGENT_OUT="$OUT/agent"
mkdir -p "$AGENT_OUT" "$AGENT_OUT/scratch"
chown -R "$GOBY_AGENT_USER:$GOBY_AGENT_USER" "$AGENT_OUT"
chmod 700 "$AGENT_OUT"

# One script, so the unprivileged side is not assembled out of nested quotes.
cat > "$OUT/run-agent.sh" <<RUN
#!/usr/bin/env bash
set -euo pipefail
cd "$SANDBOX"
exec pi --print --model "$PROVIDER/$MODEL" --no-session --no-extensions \
  --extension /opt/goby/report_findings.ts \
  --tools bash,read,grep,find,ls,report_findings --exclude-tools edit,write \
  "Read your brief at $OUT/prompt.md. It is the whole task: $GOBY_REPO#$GOBY_PR at $(printf '%s' "$GOBY_HEAD" | cut -c1-10). Do it, then call report_findings."
RUN
chmod 755 "$OUT/run-agent.sh"

goby_log "review $GOBY_REPO#$GOBY_PR model=$MODEL max_tool_calls=$GOBY_MAX_TOOL_CALLS"
AGENT_STARTED=$SECONDS
set +e
goby_run_as_agent \
  PI_CODING_AGENT_DIR="$AGENT_HOME" \
  PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  GOBY_MODEL_KEY=dummy-proxy-key \
  GOBY_SESSION_ID="review-pr${GOBY_PR}-${GOBY_HEAD:0:10}" \
  GOBY_AGENT_OUT="$AGENT_OUT" GOBY_OUT="$OUT" GOBY_SCRATCH="$AGENT_OUT/scratch" \
  GOBY_SANDBOX="$SANDBOX" GOBY_REPO="$GOBY_REPO" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
  GOBY_MAX_TOOL_CALLS="$GOBY_MAX_TOOL_CALLS" \
  GOBY_MAX_TURNS="$GOBY_MAX_TURNS" \
  GOBY_BASH_TIMEOUT_S="$GOBY_BASH_TIMEOUT_S" \
  bash "$OUT/run-agent.sh" > "$OUT/agent.log" 2>&1
AGENT_STATUS=$?
AGENT_ELAPSED=$((SECONDS - AGENT_STARTED))
set -e
tail -20 "$OUT/agent.log" || true
goby_log "agent exit=$AGENT_STATUS findings=$(grep -c '"kind":"findings"' "$AGENT_OUT/findings.jsonl" 2>/dev/null || echo 0)"

# A review that produced no findings record did not answer. Treat it as a failed review rather
# than as "no bugs": those two are the failure this design exists to keep apart.
if ! grep -q '"kind":"findings"' "$AGENT_OUT/findings.jsonl" 2>/dev/null; then
  # Not "no bugs": the reviewer never answered. Both statuses have to resolve, or the gate stays
  # pending forever and the pull request is blocked with nothing to read.
  goby_log "error: the reviewer never reported (exit $AGENT_STATUS)"
  GOBY_REPO="$GOBY_REPO" GOBY_HEAD="$GOBY_HEAD" GITHUB_TOKEN="$GITHUB_TOKEN" \
  GOBY_FAIL_REASON="the reviewer exited without reporting (exit $AGENT_STATUS)" \
    node /opt/goby/reviewRun.js fail || true
  exit 1
fi

goby_proxy_stop
GOBY_REPO="$GOBY_REPO" GOBY_PR="$GOBY_PR" GOBY_HEAD="$GOBY_HEAD" GOBY_BASE="$GOBY_BASE" \
GOBY_MODEL="$MODEL" GITHUB_TOKEN="$GITHUB_TOKEN" GOBY_OUT="$OUT" GOBY_AGENT_OUT="$AGENT_OUT" \
GOBY_ELAPSED_S="$AGENT_ELAPSED" GOBY_GATE="${GOBY_GATE:-off}" \
  node /opt/goby/reviewRun.js finish
