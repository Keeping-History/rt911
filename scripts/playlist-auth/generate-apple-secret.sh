#!/usr/bin/env bash
# Generate the Sign in with Apple client secret: an ES256 JWT signed with the
# .p8 key from the Apple Developer portal. Apple caps validity at 6 months —
# rerun this before expiry and update AUTH_APPLE_CLIENT_SECRET in rt911-secrets
# (see README "Apple client-secret rotation").
#
# Usage:
#   APPLE_TEAM_ID=... APPLE_SERVICES_ID=... APPLE_KEY_ID=... \
#     ./generate-apple-secret.sh /path/to/AuthKey_<KEYID>.p8
#
# Prints the JWT on stdout and its expiry date on stderr. No dependencies
# beyond openssl + python3 stdlib (ES256 DER→raw conversion done inline).
set -euo pipefail
P8="${1:?path to AuthKey_<KEYID>.p8 required}"
: "${APPLE_TEAM_ID:?}" "${APPLE_SERVICES_ID:?}" "${APPLE_KEY_ID:?}"

NOW=$(date +%s)
EXP=$((NOW + 15552000)) # 180 days; Apple max is ~6 months

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

HEADER=$(printf '{"alg":"ES256","kid":"%s"}' "$APPLE_KEY_ID" | b64url)
PAYLOAD=$(printf '{"iss":"%s","iat":%d,"exp":%d,"aud":"https://appleid.apple.com","sub":"%s"}' \
	"$APPLE_TEAM_ID" "$NOW" "$EXP" "$APPLE_SERVICES_ID" | b64url)

# openssl emits an ASN.1 DER ECDSA signature; JWS ES256 wants raw R||S (64
# bytes). Parse the DER integers with python stdlib and re-encode.
SIG=$(printf '%s.%s' "$HEADER" "$PAYLOAD" \
	| openssl dgst -sha256 -sign "$P8" -binary \
	| python3 -c '
import sys, base64
der = sys.stdin.buffer.read()
# DER: 0x30 len 0x02 rlen R 0x02 slen S
assert der[0] == 0x30
i = 2 + (1 if der[1] & 0x80 else 0)  # skip long-form length byte if present
assert der[i] == 0x02
rlen = der[i + 1]; r = der[i + 2 : i + 2 + rlen]; i += 2 + rlen
assert der[i] == 0x02
slen = der[i + 1]; s = der[i + 2 : i + 2 + slen]
raw = int.from_bytes(r, "big").to_bytes(32, "big") + int.from_bytes(s, "big").to_bytes(32, "big")
sys.stdout.write(base64.urlsafe_b64encode(raw).rstrip(b"=").decode())
')

echo "expires: $(date -u -d @$EXP +%Y-%m-%d) (set a reminder to rotate before then)" >&2
printf '%s.%s.%s\n' "$HEADER" "$PAYLOAD" "$SIG"
