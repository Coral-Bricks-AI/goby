#!/usr/bin/env bash
# Conventions shared by every goby image: where secrets live, how the agent is dropped, and how
# the model key stays out of reach.
#
# Sourced, never executed. Nothing here decides anything a test should cover — the decisions
# (which component, which findings, what may be filed) stay in Python or TypeScript with tests,
# as cleaners' own INVARIANTS.md requires.
set -euo pipefail

GOBY_AGENT_USER="${GOBY_AGENT_USER:-agent}"
GOBY_AGENT_UID="${GOBY_AGENT_UID:-10001}"
GOBY_TOKEN_FILE="${GOBY_TOKEN_FILE:-/run/goby/token}"
GOBY_KEY_FILE="${GOBY_KEY_FILE:-/run/goby/model-key}"
GOBY_PROXY_PORT="${GOBY_PROXY_PORT:-8787}"
GOBY_PROXY_PID="${GOBY_PROXY_PID:-/run/goby/keyproxy.pid}"

goby_log() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${GOBY_LOG_NAME:-goby}" "$*"; }

# The token is written once, root-only, and read back by the step that publishes. It is never
# exported into an agent's environment.
goby_token_to_file() {
  local token="${GITHUB_TOKEN:-}"
  [[ -n "$token" ]] || { goby_log "error: GITHUB_TOKEN is required"; return 2; }
  umask 077
  mkdir -p "$(dirname "$GOBY_TOKEN_FILE")"
  printf '%s' "$token" > "$GOBY_TOKEN_FILE"
  umask 022
}

# Root writes the real key to a root-only file; the agent never sees it, and the proxy reads it.
goby_key_to_file() {
  local key="$1"
  [[ -n "$key" ]] || { goby_log "error: no model key in the environment"; return 2; }
  umask 077
  mkdir -p "$(dirname "$GOBY_KEY_FILE")"
  printf '%s' "$key" > "$GOBY_KEY_FILE"
  umask 022
}

# `header` and `scheme` are the provider's, not a constant: Anthropic authenticates with
# `x-api-key` and no scheme, so the default would forward the agent's *dummy* there while adding
# the real key to an `authorization` header the API ignores. Callers pass theirs.
goby_proxy_start() {
  # `-`, not `:-`: an empty scheme is a *value* — Anthropic sends `x-api-key` with no prefix —
  # and `:-` would replace it with `Bearer `, so the proxy would forward `x-api-key: Bearer <key>`
  # and the provider would reject its own credential. Only an absent argument takes the default.
  local upstream="$1" header="${2-authorization}" scheme="${3-Bearer }"
  mkdir -p "$(dirname "$GOBY_PROXY_PID")"
  GOBY_PROXY_PORT="$GOBY_PROXY_PORT" GOBY_UPSTREAM="$upstream" GOBY_KEY_FILE="$GOBY_KEY_FILE" \
    GOBY_KEY_HEADER="$header" GOBY_KEY_SCHEME="$scheme" \
    node "$GOBY_HOME/keyproxy.mjs" &
  echo $! > "$GOBY_PROXY_PID"
  # Answer, not assumption: a proxy that spawned but cannot serve turns every review into a
  # model error with no explanation.
  local i
  for i in $(seq 1 50); do
    if node -e "const s=require('node:net').connect($GOBY_PROXY_PORT,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"; then
      goby_log "keyproxy ready on 127.0.0.1:$GOBY_PROXY_PORT -> $(printf '%s' "$upstream" | sed 's|https\?://||; s|/.*||')"
      return 0
    fi
    sleep 0.1
  done
  goby_log "error: keyproxy did not answer on 127.0.0.1:$GOBY_PROXY_PORT"
  return 2
}

goby_proxy_stop() {
  [[ -f "$GOBY_PROXY_PID" ]] || return 0
  kill "$(cat "$GOBY_PROXY_PID")" 2>/dev/null || true
  rm -f "$GOBY_PROXY_PID"
}

# The agent runs as its own uid with an empty environment, so nothing from this shell leaks into
# it: not the token, not the key, not a variable added later. Callers append the few names the
# work actually needs.
goby_run_as_agent() {
  local extra_env=("$@")
  runuser -u "$GOBY_AGENT_USER" -- env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME="/home/$GOBY_AGENT_USER" TMPDIR=/tmp \
    "${extra_env[@]}"
}
