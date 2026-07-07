#!/usr/bin/env bash
# Create/refresh the flight-recon-secrets Secret by copying DIRECTUS_API_TOKEN
# from the existing video-grabber-secrets, entirely server-side — the token is
# never written to disk or committed.
set -euo pipefail

NS=video-grabber
TOKEN=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.DIRECTUS_API_TOKEN}' | base64 -d)

kubectl create secret generic flight-recon-secrets -n "$NS" \
  --from-literal=DIRECTUS_API_TOKEN="$TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "flight-recon-secrets applied in namespace $NS"
