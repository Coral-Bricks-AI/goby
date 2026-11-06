#!/usr/bin/env bash
# One tide scan: one measured smell in one repository at one commit.
#
#   tide.sh --repo-dir DIR --sandbox DIR --check NAME --path PATH --facts FILE \
#           --sha SHA --model PROVIDER/MODEL --out DIR [--rules FILE] [--config FILE]
#
# Exits 0 whether or not a proposal was produced. The harness reads $TIDE_OUT, and reads the
# refactor out of $TIDE_SANDBOX with `git diff` after this returns.
set -euo pipefail

REPO_DIR="" SANDBOX="" CHECK="" PATH_UNDER_TEST="" FACTS="" SHA="" MODEL="" OUT=""
RULES="/dev/null" CONFIG="/dev/null"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)  REPO_DIR="$2"; shift 2 ;;
    --sandbox)   SANDBOX="$2"; shift 2 ;;
    --check)     CHECK="$2"; shift 2 ;;
    --path)      PATH_UNDER_TEST="$2"; shift 2 ;;
    --facts)     FACTS="$2"; shift 2 ;;
    --sha)       SHA="$2"; shift 2 ;;
    --model)     MODEL="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --rules)     RULES="$2"; shift 2 ;;
    --config)    CONFIG="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

: "${REPO_DIR:?}"; : "${SANDBOX:?}"; : "${CHECK:?}"; : "${PATH_UNDER_TEST:?}"
: "${FACTS:?}"; : "${SHA:?}"; : "${MODEL:?}"; : "${OUT:?}"
# The credential the selected provider needs, and no other: the models file interpolates it, and
# pi refuses to start on an unset variable. Checked per provider so a sweep on Claude or GPT does
# not demand our Coral key — the entrypoint already resolved which one is usable.
case "${MODEL%%/*}" in
  coral)     : "${CORALBRICKS_API_KEY:?CORALBRICKS_API_KEY must be set for a coral model}" ;;
  anthropic) : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set for an anthropic model}" ;;
  openai)    : "${OPENAI_API_KEY:?OPENAI_API_KEY must be set for an openai model}" ;;
  deepinfra) : "${DEEPINFRA_API_KEY:?DEEPINFRA_API_KEY must be set for a deepinfra model}" ;;
  *) echo "unknown provider in --model $MODEL" >&2; exit 2 ;;
esac
# A missing measurement is a wiring error, not a model error, and a traceback would exit
# non-zero and be retried as though the model had failed.
if [[ ! -f "$FACTS" ]]; then
  echo "error: facts file $FACTS does not exist; refusing to scan without a measurement" >&2
  exit 2
fi

if ! mkdir -p "$OUT"; then
  echo "error: cannot create $OUT (parent $(dirname "$OUT"): $(stat -c '%U %a' "$(dirname "$OUT")" 2>/dev/null || echo unknown))" >&2
  exit 2
fi
OUT="$(cd "$OUT" && pwd)"

# One id per run, not per path+sha: two scans of the same file are two jobs, and merging their
# spend under one session id makes cost attribution wrong.
RUN_ID="${TIDE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

TIDE_PROMPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export TIDE_PROMPT_DIR

# The emit tool has to be named in the allowlist: --tools is a full replacement, and an
# extension tool it does not name is never declared to the model. A run that finds a smell and
# cannot report it is the exact failure this check exists to prevent.
REQUIRED_TOOLS="report_proposal"
TOOLS="${TIDE_TOOLS:-read,grep,find,ls,bash,report_proposal}"
EXTENSIONS="${TIDE_EXTENSIONS:-${PI_EXTENSION:-/opt/tide/report_proposal.ts}}"
for required in ${REQUIRED_TOOLS//,/ }; do
  case ",$TOOLS," in
    *",$required,"*) ;;
    *) echo "$required missing from --tools; the run would discard every proposal" >&2; exit 2 ;;
  esac
done
has_report=0
for extension in ${EXTENSIONS//,/ }; do
  [[ "$(basename "$extension")" == "report_proposal.ts" ]] && has_report=1
done
if [[ $has_report -ne 1 ]]; then
  echo "report_proposal.ts missing from TIDE_EXTENSIONS; the run would discard every proposal" >&2
  exit 2
fi

export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/opt/tide}"
export TIDE_OUT="$OUT"
export TIDE_CHECK="$CHECK"
export TIDE_PATH="$PATH_UNDER_TEST"
# The only writable places a shell gets, and the only TIDE_* variables that survive the child
# environment allowlist: the sandbox the refactor happens in, and scratch space.
export TIDE_SANDBOX="$SANDBOX"
export TIDE_SCRATCH="${TIDE_SCRATCH:-$OUT/scratch}"
mkdir -p "$TIDE_SCRATCH"
export TIDE_SESSION_ID="${TIDE_SESSION_ID:-tide-${CHECK}-${SHA:0:10}-$RUN_ID}"

PROMPT=$(python3 - "$CHECK" "$PATH_UNDER_TEST" "$SHA" "$FACTS" "$RULES" "$CONFIG" \
                    "$SANDBOX" "$REPO_DIR" <<'PY'
import json, os, pathlib, sys
check, path, sha, facts, rules, config, sandbox, repo_dir = sys.argv[1:9]
tpl_path = pathlib.Path("/opt/tide/prompt.md")
if not tpl_path.is_file():
    tpl_path = pathlib.Path(os.environ["TIDE_PROMPT_DIR"]) / "prompt.md"
tpl = tpl_path.read_text()
body = tpl.split("<!-- BODY -->", 1)[1].strip() if "<!-- BODY -->" in tpl else tpl


def read(target):
    """`replace` semantics throughout: one unreadable byte must not abort the render."""
    p = pathlib.Path(target)
    return p.read_bytes().decode("utf-8", "replace").strip() if p.is_file() else ""


measurement = json.loads(pathlib.Path(facts).read_text())
render = (body.replace("{{REPO}}", os.environ.get("REPO") or pathlib.Path(repo_dir).name)
              .replace("{{SHA}}", sha)
              .replace("{{CHECK}}", check)
              .replace("{{PATH}}", path)
              .replace("{{METRIC}}", f"{measurement['metric']:,}")
              .replace("{{THRESHOLD}}", f"{measurement['threshold']:,}")
              .replace("{{UNIT}}", measurement["unit"])
              .replace("{{FACTS}}", json.dumps(
                  {k: v for k, v in measurement.items()
                   if k in ("check", "path", "metric", "threshold", "unit", "facts")}, indent=2))
              .replace("{{SANDBOX}}", sandbox)
              .replace("{{CONFIG}}", read(config) or "(no .goby/tide.json)")
              .replace("{{RULE_FILES}}", read(rules) or "(none provided)"))
print(render)
PY
)

cd "$REPO_DIR"
# The agent gets read-only tools pointed at the reference tree; the *sandbox* is where it writes,
# with a shell. --no-extensions then -e keeps a repository's own .pi resources out of the run.
PI_ARGS=(
  --model "$MODEL"
  --no-session
  --no-extensions
  --tools "$TOOLS"
  --exclude-tools edit,write
)
for extension in ${EXTENSIONS//,/ }; do
  if [[ ! -f "$extension" ]]; then
    echo "error: extension $extension does not exist" >&2
    exit 2
  fi
  PI_ARGS+=(--extension "$extension")
done
PI_ARGS+=("$PROMPT")

STARTED=$SECONDS
if [[ "${TIDE_JSON:-0}" == "1" ]]; then
  pi --mode json "${PI_ARGS[@]}" > "$OUT/events.jsonl"
else
  pi --print "${PI_ARGS[@]}"
fi

# The run's own record: what was scanned, with which model, for how long, and where it came from.
python3 - "$OUT/run.json" "$CHECK" "$PATH_UNDER_TEST" "$SHA" "$MODEL" "$(( SECONDS - STARTED ))" \
         "$RUN_ID" "$REPO_DIR" <<'PY'
import json, pathlib, sys, time
out, check, path, sha, model, elapsed, run_id, repo_dir = sys.argv[1:9]
pathlib.Path(out).write_text(json.dumps({
    "run_id": run_id,
    "check": check,
    "path": path,
    "sha": sha,
    "model": model,
    "repo_dir": repo_dir,
    "wall_s": int(elapsed),
    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}, indent=2) + "\n")
PY
