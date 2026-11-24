#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FRONTEND="$ROOT/frontend"
LOCAL_DIR="$ROOT/.local/dev"
API_URL="http://127.0.0.1:8000"
WEB_URL="http://127.0.0.1:3000"
mkdir -p "$LOCAL_DIR"

say() { printf '[SafetyProof] %s\n' "$*"; }
fail() { printf '[SafetyProof] ERROR: %s\n' "$*" >&2; exit 1; }

worktrees() {
  git -C "$ROOT" worktree list --porcelain | awk '$1 == "worktree" { sub(/^worktree /, ""); print }'
}

reuse_private_file() {
  local relative="$1" candidate
  [[ -e "$ROOT/$relative" ]] && return 0
  while IFS= read -r candidate; do
    [[ "$candidate" == "$ROOT" ]] && continue
    if [[ -f "$candidate/$relative" ]]; then
      ln -s "$candidate/$relative" "$ROOT/$relative"
      say "Reusing private $relative from an existing SafetyProof worktree."
      return 0
    fi
  done < <(worktrees)
  return 1
}

reuse_directory() {
  local relative="$1" candidate
  [[ -d "$ROOT/$relative" ]] && return 0
  while IFS= read -r candidate; do
    [[ "$candidate" == "$ROOT" ]] && continue
    if [[ -d "$candidate/$relative" ]]; then
      ln -s "$candidate/$relative" "$ROOT/$relative"
      say "Reusing installed $relative from an existing SafetyProof worktree."
      return 0
    fi
  done < <(worktrees)
  return 1
}

reuse_private_file ".env" || fail "No root .env was found in this or another SafetyProof worktree."
reuse_directory "frontend/node_modules" || fail "frontend/node_modules is missing. Run npm --prefix frontend ci first."

PYTHON=""
for candidate in "$ROOT/.venv/bin/python"; do
  if [[ -x "$candidate" ]] && "$candidate" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))'; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  while IFS= read -r candidate; do
    if [[ -x "$candidate/.venv/bin/python" ]] && "$candidate/.venv/bin/python" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))'; then
      PYTHON="$candidate/.venv/bin/python"
      break
    fi
  done < <(worktrees)
fi
[[ -n "$PYTHON" ]] || fail "Python 3.12 virtualenv not found. Create .venv and install backend/requirements-dev.lock."

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || fail "Node is not available. SafetyProof requires Node 22 or newer."
NODE_MAJOR="$($NODE -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail "Could not determine the Node version."
(( NODE_MAJOR >= 22 )) || fail "Node 22 or newer is required; found $($NODE --version)."
if (( NODE_MAJOR != 22 )); then
  say "Node 22 is preferred; using compatible $($NODE --version)."
fi

"$PYTHON" - "$ROOT/.env" <<'PY'
import sys
from dotenv import dotenv_values

values = dotenv_values(sys.argv[1])
required = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY")
missing = [name for name in required if not values.get(name)]
if missing:
    print("[SafetyProof] ERROR: Missing required .env names: " + ", ".join(missing), file=sys.stderr)
    raise SystemExit(1)
PY

COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"

port_pids() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

port_pid() {
  port_pids "$1" | head -n 1 || true
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true
}

same_repository() {
  local cwd="$1" common
  [[ -n "$cwd" ]] || return 1
  common="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [[ "$common" == "$COMMON_DIR" ]]
}

stop_verified_pid() {
  local pid="$1" port="$2" kind="$3" cwd command
  [[ -n "$pid" ]] || return 0
  cwd="$(pid_cwd "$pid")"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  same_repository "$cwd" || fail "Port $port belongs to an unrelated process (PID $pid); it was not stopped."
  case "$kind:$command" in
    backend:*uvicorn*|backend:*python*|frontend:*next-server*|frontend:*next\ dev*|frontend:*node*) ;;
    *) fail "Port $port has an unrecognized SafetyProof process (PID $pid); it was not stopped." ;;
  esac
  say "Stopping stale SafetyProof $kind on port $port (PID $pid)."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..40}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  fail "SafetyProof $kind PID $pid did not stop cleanly."
}

stop_verified_listener() {
  stop_verified_pid "$(port_pid "$1")" "$1" "$2"
}

wait_for() {
  local url="$1" label="$2" log="$3"
  for _ in {1..80}; do
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  printf '[SafetyProof] %s failed. Recent log output:\n' "$label" >&2
  tail -n 25 "$log" >&2 2>/dev/null || true
  return 1
}

verify_frontend() {
  local base home login retired
  for base in "http://127.0.0.1:3000" "http://localhost:3000"; do
    home="$(curl -fsS --max-time 5 "$base/" 2>/dev/null || true)"
    login="$(curl -fsS --max-time 5 "$base/login" 2>/dev/null || true)"
    retired="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$base/design-preview/garment-command-center" 2>/dev/null || true)"
    [[ "$home" == *"Evidence operations platform"* ]] || return 1
    [[ "$login" == *"Authorized access"* ]] || return 1
    [[ "$retired" == "404" ]] || return 1
  done
}

STARTED_BACKEND=""
STARTED_FRONTEND=""
BACKEND_LISTENER=""
FRONTEND_LISTENER=""
CLEANED_UP=""

cleanup() {
  [[ -z "$CLEANED_UP" ]] || return 0
  CLEANED_UP=1
  for pid in "$FRONTEND_LISTENER" "$STARTED_FRONTEND" "$BACKEND_LISTENER" "$STARTED_BACKEND"; do
    [[ -n "$pid" ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  [[ -z "$STARTED_FRONTEND" ]] || wait "$STARTED_FRONTEND" 2>/dev/null || true
  [[ -z "$STARTED_BACKEND" ]] || wait "$STARTED_BACKEND" 2>/dev/null || true
}
on_signal() {
  cleanup
  exit 0
}
trap cleanup EXIT
trap on_signal INT TERM

backend_pid="$(port_pid 8000)"
if curl -fsS --max-time 3 "$API_URL/health" >/dev/null 2>&1; then
  [[ -n "$backend_pid" ]] || fail "The API is healthy but its listener cannot be identified safely."
  same_repository "$(pid_cwd "$backend_pid")" || fail "Port 8000 is healthy but belongs to another project; it was not reused."
  say "Reusing healthy SafetyProof API on port 8000."
else
  [[ -z "$backend_pid" ]] || stop_verified_listener 8000 backend
  say "Starting FastAPI from $ROOT."
  (
    cd "$ROOT"
    exec env PYTHONPATH=backend "$PYTHON" -m uvicorn safetyproof.main:app --host 127.0.0.1 --port 8000
  ) >"$LOCAL_DIR/backend.log" 2>&1 &
  STARTED_BACKEND=$!
  wait_for "$API_URL/health" "FastAPI startup" "$LOCAL_DIR/backend.log" || exit 1
  BACKEND_LISTENER="$(port_pid 8000)"
fi

wait_for "$API_URL/v1/config" "API configuration check" "$LOCAL_DIR/backend.log" || exit 1
"$PYTHON" - "$ROOT/.env" <<'PY' || fail "Hosted Supabase Auth is not reachable from this machine."
import sys
import httpx
from dotenv import dotenv_values

values = dotenv_values(sys.argv[1])
url = (values.get("SUPABASE_URL") or "").rstrip("/") + "/auth/v1/health"
try:
    response = httpx.get(
        url,
        headers={"apikey": values.get("SUPABASE_ANON_KEY") or ""},
        timeout=8,
    )
    response.raise_for_status()
except Exception:
    raise SystemExit(1)
PY
say "FastAPI config and hosted Supabase Auth checks passed."

frontend_pid=""
while IFS= read -r listener_pid; do
  [[ -n "$listener_pid" ]] || continue
  frontend_cwd="$(pid_cwd "$listener_pid")"
  if [[ "$frontend_cwd" == "$FRONTEND" && -z "$frontend_pid" ]]; then
    frontend_pid="$listener_pid"
  else
    stop_verified_pid "$listener_pid" 3000 frontend
  fi
done < <(port_pids 3000)

if [[ -n "$frontend_pid" ]]; then
  if verify_frontend; then
    say "Reusing the verified V2 frontend on port 3000."
  else
    stop_verified_pid "$frontend_pid" 3000 frontend
    frontend_pid=""
  fi
fi

if [[ -z "$frontend_pid" ]]; then
  say "Starting Next.js from $FRONTEND."
  env NEXT_PUBLIC_API_URL="$API_URL" npm --prefix "$FRONTEND" run dev -- --webpack --hostname 127.0.0.1 --port 3000 >"$LOCAL_DIR/frontend.log" 2>&1 &
  STARTED_FRONTEND=$!
  wait_for "$WEB_URL" "Next.js startup" "$LOCAL_DIR/frontend.log" || exit 1
  FRONTEND_LISTENER="$(port_pid 3000)"
  verify_frontend || fail "Frontend route verification failed for localhost and 127.0.0.1."
fi

say "Frontend: $WEB_URL"
say "Also at:  http://localhost:3000"
say "API:      $API_URL"
say "Logs:     $LOCAL_DIR"
say "Press Ctrl+C to stop services started by this command."

while :; do
  [[ -z "$STARTED_BACKEND" ]] || kill -0 "$STARTED_BACKEND" 2>/dev/null || fail "FastAPI stopped unexpectedly; see $LOCAL_DIR/backend.log."
  [[ -z "$STARTED_FRONTEND" ]] || kill -0 "$STARTED_FRONTEND" 2>/dev/null || fail "Next.js stopped unexpectedly; see $LOCAL_DIR/frontend.log."
  sleep 2
done
