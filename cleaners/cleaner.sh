#!/usr/bin/env bash
# One scan: one component of one repo at one commit.
#
#   cleaner.sh --repo-dir DIR --component PATH --sha SHA [--before SHA] \
#           --charter FILE --model PROVIDER/MODEL --out DIR [--rules FILE] [--changed FILE]
#
# Exits 0 whether or not findings were produced. The harness reads $CLEANERS_OUT.
set -euo pipefail

REPO_DIR="" COMPONENT="" SHA="" BEFORE="" CHARTER="" MODEL="" OUT=""
RULES="/dev/null" CHANGED="/dev/null"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)  REPO_DIR="$2"; shift 2 ;;
    --component) COMPONENT="$2"; shift 2 ;;
    --sha)       SHA="$2"; shift 2 ;;
    --before)    BEFORE="$2"; shift 2 ;;
    --charter)   CHARTER="$2"; shift 2 ;;
    --model)     MODEL="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --rules)     RULES="$2"; shift 2 ;;
    --changed)   CHANGED="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

: "${REPO_DIR:?}"; : "${COMPONENT:?}"; : "${SHA:?}"; : "${CHARTER:?}"
: "${MODEL:?}"; : "${OUT:?}"
# The agent holds a dummy, not a key: the entrypoint's loopback proxy replaces it upstream, and
# the real key belongs to a root-only file this process cannot read. Checked here so a wiring
# mistake (`GOBY_MODEL_KEY` missing from `goby_run_as_agent`) fails by name, before pi starts,
# rather than as a 401 partway through the run. The provider prefix itself needs no case: the
# proxy already decided which upstream it forwards to.
: "${GOBY_MODEL_KEY:?GOBY_MODEL_KEY must be set; the entrypoint passes the dummy key the proxy swaps}"
# Checked here rather than left to a traceback: a missing brief is a wiring error, and a
# traceback would exit non-zero and be retried as if the model call had failed.
if [[ ! -f "$CHARTER" ]]; then
  echo "error: charter $CHARTER does not exist; refusing to scan without a brief" >&2
  exit 2
fi

# Absolute, before the `cd "$REPO_DIR"` below: a relative --out would otherwise have the
# agent write into the repo checkout it is reviewing (and the caller would find nothing).
# The caller creates this. If it fails, name the directory and the owner of its parent:
# the alternative is a bare "Permission denied" from a task nobody can shell into.
if ! mkdir -p "$OUT"; then
  echo "error: cannot create $OUT (parent $(dirname "$OUT"): $(stat -c '%U %a' "$(dirname "$OUT")" 2>/dev/null || echo unknown))" >&2
  exit 2
fi
OUT="$(cd "$OUT" && pwd)"

# One id per run, not per component+sha: two scans of the same component at the same sha
# are two jobs, and merging their spend under one session id makes cost attribution wrong.
RUN_ID="${CLEANERS_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

export CLEANERS_PROMPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The emit tool has to be named in the allowlist: --tools is a full replacement, and an
# extension tool it does not name is never declared to the model. Four phase-0 runs found
# a defect and could not report it because of exactly this.
#
# The required tools are declared separately from the list that is passed, and checked
# against it: asserting a literal against itself can never fire.
REQUIRED_TOOLS="report_finding"
# A user's image adds tools without patching this file: CLEANERS_TOOLS is the whole list,
# CLEANERS_EXTENSIONS the comma-separated pi extensions backing it. Both default to what
# shipped here, so an image that adds nothing behaves exactly as before.
TOOLS="${CLEANERS_TOOLS:-read,grep,find,ls,bash,report_finding}"
EXTENSIONS="${CLEANERS_EXTENSIONS:-${PI_EXTENSION:-/opt/cleaners/report_finding.ts}}"
for required in ${REQUIRED_TOOLS//,/ }; do
  case ",$TOOLS," in
    *",$required,"*) ;;
    *) echo "$required missing from --tools; the run would discard every finding" >&2; exit 2 ;;
  esac
done
# Same reason, for the extension that declares the tool: a tool name in the allowlist with
# no extension behind it is declared to the model and then cannot be called.
has_report=0
for extension in ${EXTENSIONS//,/ }; do
  [[ "$(basename "$extension")" == "report_finding.ts" ]] && has_report=1
done
if [[ $has_report -ne 1 ]]; then
  echo "report_finding.ts missing from CLEANERS_EXTENSIONS; the run would discard every finding" >&2
  exit 2
fi

export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/opt/cleaners}"
export CLEANERS_OUT="$OUT"
export CLEANERS_COMPONENT="$COMPONENT"
# The only writable places a cleaner's shell gets, and the only CLEANERS_* variables that
# survive the child-environment allowlist.
export CLEANERS_SCRATCH="${CLEANERS_SCRATCH:-$OUT/scratch}"
mkdir -p "$CLEANERS_SCRATCH"
export CLEANERS_SESSION_ID="${CLEANERS_SESSION_ID:-clean-$(echo "$COMPONENT" | tr '/' '-')-${SHA:0:10}-$RUN_ID}"

PROMPT=$(python3 - "$COMPONENT" "$SHA" "$BEFORE" "$CHARTER" "$RULES" "$CHANGED" "$REPO_DIR" <<'PY'
import os, pathlib, sys
component, sha, before, charter, rules, changed, repo_dir = sys.argv[1:8]
tpl_path = pathlib.Path("/opt/cleaners/prompt.md")
if not tpl_path.is_file():
    tpl_path = pathlib.Path(os.environ["CLEANERS_PROMPT_DIR"]) / "prompt.md"
tpl = tpl_path.read_text()
body = tpl.split("<!-- BODY -->", 1)[1].strip() if "<!-- BODY -->" in tpl else tpl
# `replace` because the listed paths are raw bytes since `core.quotePath=false`: the list is
# advisory prompt context, and a name the scanner cannot decode must not abort the render —
# that failed the scan for every component of the push.
files = pathlib.Path(changed).read_bytes().decode("utf-8", "replace").strip() if pathlib.Path(changed).is_file() else ""
sandbox = os.environ.get("CLEANERS_SANDBOX") or "(no sandbox: this tree is read-only)"
render = (body.replace("{{REPO}}", os.environ.get("REPO") or pathlib.Path(repo_dir).name)
              .replace("{{SHA}}", sha)
              .replace("{{BEFORE}}", before or "(none)")
              .replace("{{COMPONENT}}", component)
              .replace("{{CHANGED}}", files or "(unknown; the push did not name its files)")
              .replace("{{SANDBOX}}", sandbox)
# Every one of these is prompt context. `replace` for the same reason as the changed list: a
# byte the scanner cannot decode must not abort the render for the whole push.
              .replace("{{INVARIANTS}}",
                       pathlib.Path(charter).read_bytes().decode("utf-8", "replace").strip())
              .replace("{{RULE_FILES}}", pathlib.Path(rules).read_bytes()
                       .decode("utf-8", "replace").strip()
                       if pathlib.Path(rules).is_file() else "(none provided)"))
print(render)
PY
)

cd "$REPO_DIR"
# The agent gets read-only tools; the checkout is not writable. --no-extensions then -e
# keeps a repo's own .pi resources out of the run, and only the named extensions load.
PI_ARGS=(
  --model "$MODEL"
  --no-session
  --no-extensions
  --tools "$TOOLS"
  --exclude-tools edit,write
)
for extension in ${EXTENSIONS//,/ }; do
  # Named, absent, and silently skipped is the failure mode that loses findings, so a
  # missing extension stops the scan instead.
  if [[ ! -f "$extension" ]]; then
    echo "error: extension $extension does not exist" >&2
    exit 2
  fi
  PI_ARGS+=(--extension "$extension")
done
PI_ARGS+=("$PROMPT")

STARTED=$SECONDS
if [[ "${CLEANERS_JSON:-0}" == "1" ]]; then
  pi --mode json "${PI_ARGS[@]}" > "$OUT/events.jsonl"
else
  pi --print "${PI_ARGS[@]}"
fi

# The run's own record: what was scanned, with which model, for how long, and where it came
# from. usage.py reads this for the wall time, which the event stream does not carry.
python3 - "$OUT/run.json" "$COMPONENT" "$SHA" "$BEFORE" "$MODEL" "$(( SECONDS - STARTED ))" \
         "$RUN_ID" "$REPO_DIR" <<'PY'
import json, pathlib, sys, time
out, component, sha, before, model, elapsed, run_id, repo_dir = sys.argv[1:9]
pathlib.Path(out).write_text(json.dumps({
    "run_id": run_id,
    "component": component,
    "sha": sha,
    "before": before,
    "model": model,
    "repo_dir": repo_dir,
    "wall_s": int(elapsed),
    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}, indent=2) + "\n")
PY
