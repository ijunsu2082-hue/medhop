#!/usr/bin/env bash
# Start MedHop in simulator mode: backend on http://127.0.0.1:8010, frontend on http://localhost:5180.
# No drone is involved. Press Ctrl-C to stop both.
#
# Environment:
#   MEDHOP_PYTHON   Python 3.11+ interpreter with backend/requirements.txt installed (default: python3)
#
# Works with the bash 3.2 that ships with macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${MEDHOP_PYTHON:-python3}"
# a relative path such as .venv/bin/python must still work after "cd backend"
case "$PY" in
  */*) [ -e "$PY" ] && PY="$(cd "$(dirname "$PY")" && pwd)/$(basename "$PY")" ;;
esac
BACKEND_PORT=8010
FRONTEND_PORT=5180

BACKEND_PID=""
FRONTEND_PID=""

die() {
  echo "dev-sim: $*" >&2
  exit 1
}

# ---------------------------------------------------------------- checks
command -v "$PY" >/dev/null 2>&1 || die "Python not found: '$PY'. Set MEDHOP_PYTHON to a Python 3.11+ interpreter."
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || die "$("$PY" --version 2>&1) is too old. MedHop needs Python 3.11+. Set MEDHOP_PYTHON."
"$PY" -c 'import fastapi, uvicorn, numpy, cv2; cv2.aruco' 2>/dev/null \
  || die "backend packages missing for $PY. Run: $PY -m pip install -r backend/requirements.txt"

command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 22.12 or newer."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' \
  || die "node $(node --version) is too old for Vite 8. Install Node.js 22.12 or newer."
VITE="$ROOT/frontend/node_modules/.bin/vite"
[ -x "$VITE" ] || die "frontend dependencies missing. Run: (cd frontend && npm install)"

port_busy() {
  "$PY" -c 'import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)' "$1"
}
port_busy "$BACKEND_PORT" && die "port $BACKEND_PORT is already in use (another MedHop backend?). Stop it first."
port_busy "$FRONTEND_PORT" && die "port $FRONTEND_PORT is already in use (another frontend dev server?). Stop it first."

# ---------------------------------------------------------------- cleanup
stop_all() {
  trap - INT TERM EXIT
  echo
  echo "dev-sim: stopping..."
  for pid in $FRONTEND_PID $BACKEND_PID; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # give the backend time to send neutral axes and shut down cleanly
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    alive=""
    for pid in $FRONTEND_PID $BACKEND_PID; do
      kill -0 "$pid" 2>/dev/null && alive="yes"
    done
    [ -z "$alive" ] && break
    sleep 0.5
  done
  for pid in $FRONTEND_PID $BACKEND_PID; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "dev-sim: stopped."
}
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM
trap 'stop_all' EXIT

# ---------------------------------------------------------------- start
echo "dev-sim: starting backend (simulator) on http://127.0.0.1:$BACKEND_PORT"
(cd "$ROOT/backend" && MEDHOP_DRONE=sim exec "$PY" -m medhop) &
BACKEND_PID=$!

echo "dev-sim: starting frontend on http://localhost:$FRONTEND_PORT"
# VITE_BACKEND=python: these pages talk to the backend started above, never to the simulator inside the page.
(cd "$ROOT/frontend" && VITE_BACKEND=python exec "$VITE") &
FRONTEND_PID=$!

answers() {
  "$PY" -c 'import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=1).read(64)
except Exception:
    sys.exit(1)' "$1"
}

ready=""
for _ in $(seq 1 60); do
  kill -0 "$BACKEND_PID" 2>/dev/null || die "the backend exited during startup (see its log above)."
  kill -0 "$FRONTEND_PID" 2>/dev/null || die "the frontend exited during startup (see its log above)."
  if answers "http://127.0.0.1:$BACKEND_PORT/api/health" && answers "http://localhost:$FRONTEND_PORT/"; then
    ready="yes"
    break
  fi
  sleep 1
done
[ -n "$ready" ] || die "backend or frontend did not answer within 60 s."

echo
echo "dev-sim: ready (simulator mode, no drone)."
echo "  Home:      http://localhost:$FRONTEND_PORT/"
echo "  Pilot:     http://localhost:$FRONTEND_PORT/pilot"
echo "  Care:      http://localhost:$FRONTEND_PORT/care"
echo "  Caregiver: http://localhost:$FRONTEND_PORT/caregiver"
echo "  Press Ctrl-C to stop both."
echo

# keep running until either process exits or Ctrl-C
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
die "one of the processes exited (see its log above)."
