#!/usr/bin/env bash
set -e

# Load environment variables from .env if present
if [ -f .env ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | xargs)
fi

PORT_TO_USE=${PORT:-${BACKEND_PORT:-3000}}
ORTHANC_PORT_TO_USE=${ORTHANC_PORT:-${ORTHANC_HTTP_PORT:-8042}}
ORTHANC_USER_TO_USE=${ORTHANC_USER:-${ORTHANC_USERNAME:-orthanc}}
ORTHANC_PASS_TO_USE=${ORTHANC_PASSWORD:-orthanc}
LOGIN_EMAIL_TO_USE=${TEST_USER_EMAIL:-test@micd.local}
LOGIN_PASSWORD_TO_USE=${TEST_USER_PASSWORD:-testpassword}

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✔${NC} $1"; }
fail() { echo -e "  ${RED}✘${NC} $1"; FAILED=1; }
info() { echo -e "${CYAN}▶${NC} $1"; }

FAILED=0

echo ""
info "Checking MICD backend stack..."
echo ""

# ── Containers ────────────────────────────────────────────────────────────────
info "Containers"

for name in micd-postgres micd-orthanc micd-backend; do
  status=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$name" 2>/dev/null || echo "missing")

  if [ "$status" = "running" ]; then
    if [ "$health" = "healthy" ] || [ "$health" = "no-healthcheck" ]; then
      ok "$name ($status / $health)"
    else
      fail "$name ($status / $health)"
    fi
  else
    fail "$name ($status)"
  fi
done

echo ""

# ── Backend health ────────────────────────────────────────────────────────────
info "Backend"

HEALTH=$(curl -sf http://localhost:"${PORT_TO_USE}"/api/health 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ORTHANC_VER=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('orthanc','?'))" 2>/dev/null)
  ok "GET /api/health → ok (Orthanc $ORTHANC_VER)"
else
  fail "GET /api/health → not reachable or degraded"
fi

TOKEN=$(curl -sf -X POST http://localhost:"${PORT_TO_USE}"/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${LOGIN_EMAIL_TO_USE}\",\"password\":\"${LOGIN_PASSWORD_TO_USE}\"}" \
  2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null)
if [ -n "$TOKEN" ]; then
  ok "POST /auth/login → got access token"
else
  fail "POST /auth/login → failed to authenticate as ${LOGIN_EMAIL_TO_USE}"
fi

STUDIES=$(curl -sf -H "Authorization: Bearer ${TOKEN}" http://localhost:"${PORT_TO_USE}"/api/studies 2>/dev/null || echo "")
if echo "$STUDIES" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  COUNT=$(echo "$STUDIES" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
  ok "GET /api/studies → $COUNT study/studies in Orthanc"
else
  fail "GET /api/studies → invalid response"
fi

echo ""

# ── Orthanc auth and metrics ──────────────────────────────────────────────────
info "Orthanc"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:"${ORTHANC_PORT_TO_USE}"/studies 2>/dev/null)
if [ "$STATUS" = "401" ]; then
  ok "Unauthenticated request → 401 Unauthorized"
else
  fail "Unauthenticated request → expected 401, got $STATUS"
fi

INSTANCES_JSON=$(curl -sf -u "${ORTHANC_USER_TO_USE}:${ORTHANC_PASS_TO_USE}" http://localhost:"${ORTHANC_PORT_TO_USE}"/instances 2>/dev/null || echo "")
if [ -n "$INSTANCES_JSON" ]; then
  INSTANCES_COUNT=$(echo "$INSTANCES_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  ok "Orthanc connection → $INSTANCES_COUNT DICOM instance(s) stored"
else
  fail "Orthanc connection → Failed to fetch instances count"
fi

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
if [ "$FAILED" = "0" ]; then
  echo -e "${GREEN}All checks passed.${NC}"
else
  echo -e "${RED}Some checks failed — review output above.${NC}"
  exit 1
fi

echo ""
