#!/usr/bin/env bash
# Create the Teacher role/policy, playlists ownership fields, and permissions.
# Idempotent: skips anything that already exists (matched by name/field).
# Usage: DIRECTUS_ADMIN_PASSWORD=... ./apply.sh [https://api-beta.911realtime.org]
set -euo pipefail
URL="${1:-https://api-beta.911realtime.org}"

TOKEN=$(curl -sS -X POST "$URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@911realtime.org\",\"password\":\"$DIRECTUS_ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])")
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

req() { # method path body — logs response body on non-2xx and exits
  local out; out=$(curl -sS -g -X "$1" "$URL$2" "${auth[@]}" ${3:+-d "$3"} -w $'\n%{http_code}')
  local code="${out##*$'\n'}" body="${out%$'\n'*}"
  if [[ "$code" != 2* ]]; then echo "FAILED $1 $2 -> $code: $body" >&2; exit 1; fi
  echo "$body"
}

# --- schema fields (serial; skip if present) -------------------------------
have_field() { req GET "/fields/playlists" | python3 -c "
import sys,json; print(any(f['field']=='$1' for f in json.load(sys.stdin)['data']))"; }
[ "$(have_field user_created)" = True ] || req POST /fields/playlists \
  '{"field":"user_created","type":"uuid","meta":{"special":["user-created"],"interface":"select-dropdown-m2o","readonly":true,"hidden":true},"schema":{}}' >/dev/null
[ "$(have_field date_created)" = True ] || req POST /fields/playlists \
  '{"field":"date_created","type":"timestamp","meta":{"special":["date-created"],"readonly":true,"hidden":true},"schema":{}}' >/dev/null
[ "$(have_field date_updated)" = True ] || req POST /fields/playlists \
  '{"field":"date_updated","type":"timestamp","meta":{"special":["date-updated"],"readonly":true,"hidden":true},"schema":{}}' >/dev/null
echo "fields: ok"

# --- Teacher policy + role --------------------------------------------------
POLICY_ID=$(req GET "/policies?filter[name][_eq]=Teacher&fields=id" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
if [ -z "$POLICY_ID" ]; then
  POLICY_ID=$(req POST /policies '{"name":"Teacher","app_access":false,"admin_access":false,"enforce_tfa":false}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
fi
ROLE_ID=$(req GET "/roles?filter[name][_eq]=Teacher&fields=id" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
if [ -z "$ROLE_ID" ]; then
  ROLE_ID=$(req POST /roles '{"name":"Teacher","description":"Playlist authors (frontend only)"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  req POST /access "{\"role\":\"$ROLE_ID\",\"policy\":\"$POLICY_ID\"}" >/dev/null
fi
echo "TEACHER_POLICY_ID=$POLICY_ID"
echo "TEACHER_ROLE_ID=$ROLE_ID"

# --- Teacher permissions on playlists (serial) ------------------------------
OWN='{"user_created":{"_eq":"$CURRENT_USER"}}'
# read: own rows (any status) OR any published row. Directus's Public policy only
# applies to unauthenticated requests — it does not cascade to authenticated users —
# so published-read for other teachers must be encoded directly in Teacher's own rule.
OWN_OR_PUBLISHED='{"_or":[{"user_created":{"_eq":"$CURRENT_USER"}},{"status":{"_eq":"published"}}]}'
STATUS_OK='{"status":{"_in":["draft","published"]}}'
have_perm() { req GET "/permissions?filter[policy][_eq]=$POLICY_ID&filter[collection][_eq]=playlists&filter[action][_eq]=$1&fields=id" \
  | python3 -c "import sys,json; print(bool(json.load(sys.stdin)['data']))"; }
perm_id() { req GET "/permissions?filter[policy][_eq]=$POLICY_ID&filter[collection][_eq]=playlists&filter[action][_eq]=$1&fields=id" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')"; }
[ "$(have_perm create)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"create\",\"policy\":\"$POLICY_ID\",\"fields\":[\"title\",\"definition\",\"status\"],\"validation\":$STATUS_OK}" >/dev/null
# read is converged (not skip-if-present): always PATCH to the target OR rule so an
# already-applied prod permission from before the OR rule existed gets updated too.
READ_ID=$(perm_id read)
if [ -z "$READ_ID" ]; then
  req POST /permissions \
    "{\"collection\":\"playlists\",\"action\":\"read\",\"policy\":\"$POLICY_ID\",\"fields\":[\"*\"],\"permissions\":$OWN_OR_PUBLISHED}" >/dev/null
else
  req PATCH "/permissions/$READ_ID" \
    "{\"fields\":[\"*\"],\"permissions\":$OWN_OR_PUBLISHED}" >/dev/null
fi
[ "$(have_perm update)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"update\",\"policy\":\"$POLICY_ID\",\"fields\":[\"title\",\"definition\",\"status\"],\"permissions\":$OWN,\"validation\":$STATUS_OK}" >/dev/null
[ "$(have_perm delete)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"delete\",\"policy\":\"$POLICY_ID\",\"fields\":[\"*\"],\"permissions\":$OWN}" >/dev/null

# --- Teacher self-read on directus_users -------------------------------------
# With app_access:false the policy does NOT inherit Directus's built-in
# read-own-profile rules, so /users/me returns only `id` — the frontend's
# fetchMe needs email/first_name/last_name. Least privilege: own row only,
# four fields, no role/status exposure. Converged like the playlists read.
SELF_ONLY='{"id":{"_eq":"$CURRENT_USER"}}'
USERS_READ_ID=$(req GET "/permissions?filter[policy][_eq]=$POLICY_ID&filter[collection][_eq]=directus_users&filter[action][_eq]=read&fields=id" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
USERS_FIELDS='["id","email","first_name","last_name","avatar"]'
if [ -z "$USERS_READ_ID" ]; then
  req POST /permissions \
    "{\"collection\":\"directus_users\",\"action\":\"read\",\"policy\":\"$POLICY_ID\",\"fields\":$USERS_FIELDS,\"permissions\":$SELF_ONLY}" >/dev/null
else
  req PATCH "/permissions/$USERS_READ_ID" \
    "{\"fields\":$USERS_FIELDS,\"permissions\":$SELF_ONLY}" >/dev/null
fi
# --- Avatar support: file upload + own-avatar update -------------------------
# Teachers may upload files (images only — enforced globally by
# FILES_MIME_TYPE_ALLOW_LIST), read/delete their own uploads (asset delivery
# checks directus_files read), and update exactly ONE field on their own user
# row: avatar. Converged like the other special-cased permissions.
converge_perm() { # collection action fields permissions_json
  local id
  id=$(req GET "/permissions?filter[policy][_eq]=$POLICY_ID&filter[collection][_eq]=$1&filter[action][_eq]=$2&fields=id" \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
  local body="{\"collection\":\"$1\",\"action\":\"$2\",\"policy\":\"$POLICY_ID\",\"fields\":$3,\"permissions\":$4}"
  if [ -z "$id" ]; then req POST /permissions "$body" >/dev/null; else req PATCH "/permissions/$id" "$body" >/dev/null; fi
}
OWN_UPLOAD='{"uploaded_by":{"_eq":"$CURRENT_USER"}}'
converge_perm directus_files create '["*"]' 'null'
converge_perm directus_files read   '["*"]' "$OWN_UPLOAD"
converge_perm directus_files delete '["*"]' "$OWN_UPLOAD"
converge_perm directus_users update '["avatar"]' "$SELF_ONLY"
echo "permissions: ok"
