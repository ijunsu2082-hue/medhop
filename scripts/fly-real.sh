#!/usr/bin/env bash
# Start MedHop in REAL-DRONE mode: backend on http://127.0.0.1:8010, frontend on http://localhost:5180.
# Read docs/SAFETY.md and follow docs/FLIGHT_CHECKLIST.md before using this. Press Ctrl-C to stop both.
#
# Environment:
#   MEDHOP_TURBODRONE_BACKEND  required: path to the backend/ directory of a turbodrone checkout
#   MEDHOP_PYTHON              Python 3.11+ with backend/requirements.txt installed (default: python3)
#   MEDHOP_YOLO_WEIGHTS        optional: local yolo11n.pt for the advisory person check (must exist if set)
#   MEDHOP_DRONE_IP            optional: drone address (default 192.168.169.1)
#   other MEDHOP_* variables are passed through to the backend unchanged
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
TURBODRONE_PORT=8000   # turbodrone's own web server; it must not run at the same time as MedHop

BACKEND_PID=""
FRONTEND_PID=""

die() {
  echo "fly-real: $*" >&2
  exit 1
}

# ---------------------------------------------------------------- checks
TD="${MEDHOP_TURBODRONE_BACKEND:-}"
[ -n "$TD" ] || die "MEDHOP_TURBODRONE_BACKEND is not set. Set it to the backend/ directory of your turbodrone checkout. Refusing to start."
[ -f "$TD/services/flight_controller.py" ] \
  || die "MEDHOP_TURBODRONE_BACKEND=$TD does not look like turbodrone's backend/ directory (no services/flight_controller.py). Refusing to start."
# the backend runs from backend/, so hand it absolute paths
MEDHOP_TURBODRONE_BACKEND="$(cd "$TD" && pwd)"
export MEDHOP_TURBODRONE_BACKEND

WEIGHTS="${MEDHOP_YOLO_WEIGHTS:-}"
if [ -n "$WEIGHTS" ] && [ ! -f "$WEIGHTS" ]; then
  die "MEDHOP_YOLO_WEIGHTS=$WEIGHTS does not exist. Download the weights while you still have internet, or unset the variable. Refusing to start."
fi
if [ -n "$WEIGHTS" ]; then
  MEDHOP_YOLO_WEIGHTS="$(cd "$(dirname "$WEIGHTS")" && pwd)/$(basename "$WEIGHTS")"
  export MEDHOP_YOLO_WEIGHTS
fi

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

# Only one program may control the drone. Refuse while turbodrone's own server is running.
if port_busy "$TURBODRONE_PORT"; then
  die "something is listening on 127.0.0.1:$TURBODRONE_PORT (turbodrone's own web server?). Only one program may control the drone. Stop it first. Refusing to start."
fi
td_pids="$(pgrep -f 'web_server' 2>/dev/null | tr '\n' ',' | sed 's/,$//')" || td_pids=""
if [ -n "$td_pids" ]; then
  echo "fly-real: these processes look like turbodrone's own web server:" >&2
  ps -o pid=,command= -p "$td_pids" >&2 || true
  die "stop them first. Only one program may control the drone. Refusing to start."
fi
# end of controller checks

# ---------------------------------------------------------------- safety confirmation
echo
echo "REAL DRONE MODE. Before you continue:"
echo "  1. The corridor is empty and closed off, nobody is inside, and an adult is present."
echo "  2. You hold manual control and EMERGENCY STOP (Space) the whole time; Space sends the emergency stop (motor-cut command, the drone drops), and it only reaches the drone while the drone link is connected."
echo "  3. No real medicine. You have read docs/SAFETY.md and are following docs/FLIGHT_CHECKLIST.md."
echo "  4. The WiFi UAV phone app is closed and turbodrone's own server and frontend are stopped: only MedHop may talk to the drone."
echo
if [ -z "$WEIGHTS" ]; then
  echo "Note: MEDHOP_YOLO_WEIGHTS is not set, so the advisory person check will be off. Check the corridor by eye."
  echo
fi
printf 'Type yes to start: '
answer=""
read -r answer || true
[ "$answer" = "yes" ] || die "you did not type yes. Not starting."

# ---------------------------------------------------------------- cleanup
stop_all() {
  trap - INT TERM EXIT
  echo
  echo "fly-real: stopping (the backend sends neutral sticks and never the takeoff/land toggle)..."
  for pid in $FRONTEND_PID $BACKEND_PID; do
    kill -TERM "$pid" 2>/dev/null || true
  done
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
  echo "fly-real: stopped."
}
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM
trap 'stop_all' EXIT

# ---------------------------------------------------------------- start
echo "fly-real: starting backend (REAL drone at ${MEDHOP_DRONE_IP:-192.168.169.1}) on http://127.0.0.1:$BACKEND_PORT"
(cd "$ROOT/backend" && MEDHOP_DRONE=real exec "$PY" -m medhop) &
BACKEND_PID=$!

echo "fly-real: starting frontend on http://localhost:$FRONTEND_PORT"
# VITE_BACKEND=python: these pages talk to the backend started above, and through it to the real drone, never to the simulator inside the page.
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
  kill -0 "$BACKEND_PID" 2>/dev/null || die "the backend exited during startup (is the laptop on the drone's Wi-Fi? see its log above)."
  kill -0 "$FRONTEND_PID" 2>/dev/null || die "the frontend exited during startup (see its log above)."
  if answers "http://127.0.0.1:$BACKEND_PORT/api/health" && answers "http://localhost:$FRONTEND_PORT/"; then
    ready="yes"
    break
  fi
  sleep 1
done
[ -n "$ready" ] || die "backend or frontend did not answer within 60 s."

echo
echo "fly-real: ready (REAL drone)."
echo "  Pilot page: http://localhost:$FRONTEND_PORT/pilot   (keep it open and in front while flying)"
echo "  Press Ctrl-C to stop both."
echo

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
die "one of the processes exited (see its log above)."
