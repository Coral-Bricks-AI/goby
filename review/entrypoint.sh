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

# Cosmetic only (src/progress.ts): a "Goby is reviewing" note on the pull request, started once a
# review will actually run and marked done on every exit after that. Wall-clocked and `|| true`, so
# it can neither hang a review nor change how one ends.
goby_progress() { timeout 30 node /opt/goby/progress.js "$1" || true; }

# A review that cannot run has to resolve the statuses it declared open. `prepare` posts "Review in
# progress" before the clone now, so a failure in this shell would otherwise leave a pull request
# blocked on a check that never concludes — the same reason the "reviewer never reported" path
# below calls this, and the same rule as review/INVARIANTS.md 1.
goby_fail() {
  goby_log "error: $1"
  GOBY_REPO="$GOBY_REPO" GOBY_HEAD="$GOBY_HEAD" GITHUB_TOKEN="$GITHUB_TOKEN" \
  GOBY_FAIL_REASON="$1" node /opt/goby/reviewRun.js fail || true
  exit 1
}
PROVIDER="${GOBY_PROVIDER:-coral}"
MODEL="${GOBY_MODEL:-deepseek-v4.1-flash-fast}"
MAX_DIFF_LINES="$GOBY_MAX_DIFF_LINES"
WORK="${GOBY_WORK:-/workspace}"
REPO_DIR="$WORK/repo"
SANDBOX="$WORK/sandbox"
OUT="$WORK/out"
export GOBY_OUT="$OUT"
AGENT_HOME="/home/$GOBY_AGENT_USER/.pi-agent"

# The credential's header is the provider's: Anthropic reads `x-api-key` with no scheme, and a
# proxy that rewrites only `authorization` would send it the agent's dummy instead.
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

# --- what this run is -------------------------------------------------------------------
# Prepare asks GitHub everything the reuse decision needs — the API's diff digest for this head and
# base, the PR's head and base, the receipt on a previous review of this commit, the reviews this
# bot already posted — and needs no clone to answer it. So it runs first: a head that was already
# reviewed is a status refresh, and paying for a full clone and a diff that nothing will read was
# most of what such a run cost. It still talks to GitHub as root, before any drop, with the token
# in this process.
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

# --- the change -------------------------------------------------------------------------
rm -rf "${REPO_DIR:?}" "${SANDBOX:?}"; mkdir -p "$REPO_DIR" "$SANDBOX"
# AUTH goes in a per-command header, never the URL: a URL lands in .git/config inside the tree the
# reviewer reads, and the sandbox copy would carry it. Not a partial clone either: a blobless clone
# fetches blobs lazily, and that lazy fetch would go out unauthenticated from inside the sandbox.
AUTH=(-c "http.extraHeader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
goby_log "clone $GOBY_REPO@${GOBY_HEAD:0:10} (base ${GOBY_BASE:0:10})"
if ! git "${AUTH[@]}" -c advice.detachedHead=false clone --quiet --no-checkout \
  "https://github.com/${GOBY_REPO}.git" "$REPO_DIR"; then
  goby_fail "the clone of $GOBY_REPO failed"
fi
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
  goby_fail "cannot fetch $GOBY_HEAD/$MERGE_BASE; refusing to review a different commit"
fi
if [[ "$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" != "$GOBY_HEAD" ]] \
   && ! git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet "$GOBY_HEAD"; then
  goby_fail "checkout of $GOBY_HEAD failed; refusing to review a different commit"
fi

DIFF="$OUT/diff.patch"
if ! git -C "$REPO_DIR" diff --find-renames "$MERGE_BASE" "$GOBY_HEAD" > "$DIFF"; then
  goby_fail "the diff ${MERGE_BASE:0:10}..${GOBY_HEAD:0:10} could not be taken"
fi
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
goby_proxy_start "$UPSTREAM" "$KEY_HEADER" "$KEY_SCHEME"
# The progress stop is a no-op until `goby_progress start` below; it goes first as it cannot fail.
trap 'goby_progress stop; goby_proxy_stop' EXIT

# Only here, with a diff that will actually be read and a proxy that answered: a reuse refreshed a
# status, a skipped diff posted its verdict, and a failure in the clone or the proxy above has
# already resolved the statuses it opened. Past this point the note is started, and the EXIT trap
# just installed owns marking it done, whatever happens next.
goby_progress start

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
#
# `--mode json`, not `--print`: the event stream is the only record of where the run's wall clock
# went, and it is written by the agent itself, into the one directory it owns. Its stderr is pi's
# own diagnostics, kept because a refusal to start (a bad flag, a rejected key) leaves no events at
# all and this file would then be the only evidence of why. Neither stream decides the verdict —
# `report_findings` does, as before.
cat > "$OUT/run-agent.sh" <<RUN
#!/usr/bin/env bash
set -euo pipefail
cd "$SANDBOX"
exec pi --mode json --model "$PROVIDER/$MODEL" --no-session --no-extensions \
  --extension /opt/goby/report_findings.ts \
  --tools bash,read,grep,find,ls,report_findings --exclude-tools edit,write \
  "Read your brief at $OUT/prompt.md. It is the whole task: $GOBY_REPO#$GOBY_PR at $(printf '%s' "$GOBY_HEAD" | cut -c1-10). Do it, then call report_findings." \
  > "$AGENT_OUT/events.jsonl" 2> "$AGENT_OUT/stderr.log"
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
  bash "$OUT/run-agent.sh"
AGENT_STATUS=$?
AGENT_ELAPSED=$((SECONDS - AGENT_STARTED))
set -e

# What the run did, from its own record. All of it is instrumentation: every call is `|| true`,
# because an instrument that can end a review is a new way for a review to fail. The timing line is
# the one that answers "where did the agent's two minutes go" — model turns, the tool calls' own
# clocks, and the calls that took the longest — and it goes to the log and to the job summary, so a
# review that reports its own cost needs no second mechanism.
EVENTS="$AGENT_OUT/events.jsonl"
if [[ -s "$EVENTS" ]]; then
  SUMMARY="$(python3 /opt/common/summarize_run.py "$EVENTS" || true)"
  if [[ -n "$SUMMARY" ]]; then goby_log "$SUMMARY"; fi
  # Printed only when the model call failed: pi exits 0 with stopReason=error, so the exit code
  # above cannot carry it. Not a verdict here — a missing findings record is what fails a review.
  MODEL_ERROR="$(python3 /opt/common/summarize_run.py --status "$EVENTS" || true)"
  if [[ -n "$MODEL_ERROR" ]]; then goby_log "warn: $MODEL_ERROR"; fi
  TIMING="$(python3 /opt/common/timing.py "$EVENTS" --agent-seconds "$AGENT_ELAPSED" \
    --findings "$AGENT_OUT/findings.jsonl" --calls || true)"
  if [[ -n "$TIMING" ]]; then
    # One log line per tool call, then the summary line: the summary says the ratio, the sequence
    # says what the reviewer did with it, and "is it batching its probes" is only answerable from
    # the second. Every line is prefixed like the phase checkpoints so the log stays greppable.
    while IFS= read -r trace_line; do goby_log "$trace_line"; done <<< "$TIMING"
    SUMMARY_LINE="$(printf '%s\n' "$TIMING" | tail -n 1)"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] \
       && ! printf -- '- %s\n' "${SUMMARY_LINE#timing }" >> "$GITHUB_STEP_SUMMARY"; then
      goby_log "warn: could not write the timing line to the job summary"
    fi
  fi
  # The same numbers as a record, in the one place a review is kept forever: the job summary above
  # has no API and expires with the log, so from here on "what did this review cost" was answerable
  # for ninety days out of a zip. `runrecord.py` takes its clock and its price from the same two
  # functions the line above used, so the record and the line cannot disagree.
  #
  # Instrumentation, like everything in this block: a record that cannot be written is a missing
  # field for a reader, never a failed review.
  MODEL_CATALOG=()
  if [[ -f "$REPO_DIR/.goby/models.json" ]]; then
    # The same convention the cleaners and the tide follow: a repository that commits a price
    # table gets money in its records, and one that does not gets `null` and the reason.
    MODEL_CATALOG=(--models-json "$REPO_DIR/.goby/models.json")
  fi
  if ! python3 /opt/common/runrecord.py "$AGENT_OUT" --agent-seconds "$AGENT_ELAPSED" \
       --model "$MODEL" "${MODEL_CATALOG[@]}" > "$OUT/run-record.json"; then
    rm -f "$OUT/run-record.json"
    goby_log "warn: could not write the run record"
  fi
else
  goby_log "warn: the agent produced no event stream"
fi
goby_log "agent exit=$AGENT_STATUS findings=$(grep -c '"kind":"findings"' "$AGENT_OUT/findings.jsonl" 2>/dev/null || echo 0)"

# A review that produced no findings record did not answer. Treat it as a failed review rather
# than as "no bugs": those two are the failure this design exists to keep apart.
if ! grep -q '"kind":"findings"' "$AGENT_OUT/findings.jsonl" 2>/dev/null; then
  # Not "no bugs": the reviewer never answered. Both statuses have to resolve, or the gate stays
  # pending forever and the pull request is blocked with nothing to read.
  goby_log "error: the reviewer never reported (exit $AGENT_STATUS)"
  # pi's own diagnostics, which is where the reason is when it never got as far as a turn: a key
  # the provider rejected writes a session header and nothing else, so the stream above says the
  # split is unavailable without saying why.
  if [[ -f "$AGENT_OUT/stderr.log" ]]; then tail -20 "$AGENT_OUT/stderr.log"; fi
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
