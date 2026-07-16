#!/usr/bin/env bash
# Enforcement matrix verification. Safe to run against prod: creates and removes
# its own users/playlists. Usage: DIRECTUS_ADMIN_PASSWORD=... ./verify.sh [url]
set -uo pipefail
URL="${1:-https://api-beta.911realtime.org}"
FAILS=0
check() { # description expected actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected $2 got $3)"; FAILS=$((FAILS+1)); fi
}
ADMIN_TOKEN=$(curl -sS -X POST "$URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@911realtime.org\",\"password\":\"$DIRECTUS_ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])")
ROLE_ID=$(curl -sS -g "$URL/roles?filter[name][_eq]=Teacher&fields=id" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
[ -n "$ROLE_ID" ] || { echo "FAIL: Teacher role missing"; exit 1; }

PW="verify-$(date +%s)-Aa1!x"
mkuser() { curl -sS -X POST "$URL/users" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"role\":\"$ROLE_ID\",\"status\":\"active\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])"; }
A_ID=$(mkuser "verify-teacher-a@example.com"); B_ID=$(mkuser "verify-teacher-b@example.com")
cleanup() {
  for id in ${A_PL:-} ${A_PUB:-}; do curl -sS -X DELETE "$URL/items/playlists/$id" -H "Authorization: Bearer $ADMIN_TOKEN" -o /dev/null; done
  for id in $A_ID $B_ID; do curl -sS -X DELETE "$URL/users/$id" -H "Authorization: Bearer $ADMIN_TOKEN" -o /dev/null; done
}
trap cleanup EXIT
login() { curl -sS -X POST "$URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])"; }
TA=$(login "verify-teacher-a@example.com"); TB=$(login "verify-teacher-b@example.com")

DEF='{"version":1,"mode":"annotate","entries":[]}'
# create as A (draft) — expect 200, owner stamped
A_PL=$(curl -sS -X POST "$URL/items/playlists" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
  -d "{\"title\":\"verify draft\",\"status\":\"draft\",\"definition\":$DEF}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
check "teacher can create draft" "ok" "$([ -n "$A_PL" ] && echo ok)"
OWNER=$(curl -sS "$URL/items/playlists/$A_PL?fields=user_created" -H "Authorization: Bearer $TA" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['user_created'])")
check "user_created auto-stamped to A" "$A_ID" "$OWNER"
# forged owner: Directus 12 rejects the whole create (403) rather than stripping the field
FORGE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$URL/items/playlists" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
  -d "{\"title\":\"verify pub\",\"status\":\"published\",\"definition\":$DEF,\"user_created\":\"$B_ID\"}")
check "forged user_created rejected on create" 403 "$FORGE_CODE"
# legitimate create (no user_created in payload) — owner auto-stamped by Directus
A_PUB=$(curl -sS -X POST "$URL/items/playlists" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
  -d "{\"title\":\"verify pub\",\"status\":\"published\",\"definition\":$DEF}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
OWNER2=$(curl -sS "$URL/items/playlists/$A_PUB?fields=user_created" -H "Authorization: Bearer $TA" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('user_created'))")
check "user_created auto-stamped on published row" "$A_ID" "$OWNER2"
# matrix
code() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
check "A reads own draft"        200 "$(code "$URL/items/playlists/$A_PL"  -H "Authorization: Bearer $TA")"
check "B cannot read A's draft"  403 "$(code "$URL/items/playlists/$A_PL"  -H "Authorization: Bearer $TB")"
check "anon cannot read draft"   403 "$(code "$URL/items/playlists/$A_PL")"
check "anon reads published"     200 "$(code "$URL/items/playlists/$A_PUB")"
check "B reads published"        200 "$(code "$URL/items/playlists/$A_PUB" -H "Authorization: Bearer $TB")"
check "B cannot update A's row"  403 "$(code -X PATCH "$URL/items/playlists/$A_PUB" -H "Authorization: Bearer $TB" -H "Content-Type: application/json" -d '{"title":"hijack"}')"
check "A updates own row"        200 "$(code -X PATCH "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"renamed"}')"
check "A cannot set bogus status" 400 "$(code -X PATCH "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"status":"hacked"}')"
check "B cannot delete A's row"  403 "$(code -X DELETE "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TB")"
check "A deletes own row"        204 "$(code -X DELETE "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TA")"
A_PL="" # deleted; skip in cleanup
echo; [ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$FAILS CHECK(S) FAILED"; exit 1; }
