#!/usr/bin/env bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
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

HEALTH=$(curl -sf http://localhost:3000/api/health 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ORTHANC_VER=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('orthanc','?'))" 2>/dev/null)
  ok "GET /api/health → ok (Orthanc $ORTHANC_VER)"
else
  fail "GET /api/health → not reachable or degraded"
fi

STUDIES=$(curl -sf http://localhost:3000/api/studies 2>/dev/null || echo "")
if echo "$STUDIES" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  COUNT=$(echo "$STUDIES" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
  ok "GET /api/studies → $COUNT study/studies in Orthanc"
else
  fail "GET /api/studies → invalid response"
fi

echo ""

# ── Orthanc auth ──────────────────────────────────────────────────────────────
info "Orthanc"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8042/studies 2>/dev/null)
if [ "$STATUS" = "401" ]; then
  ok "Unauthenticated request → 401 Unauthorized"
else
  fail "Unauthenticated request → expected 401, got $STATUS"
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
