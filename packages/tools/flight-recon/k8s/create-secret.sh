#!/usr/bin/env bash
# Create/refresh the flight-recon-secrets Secret, entirely server-side — no
# credential is ever written to disk or committed.
#   DIRECTUS_API_TOKEN  copied from video-grabber-secrets
#   RT911_DB_DSN        composed from rt911-secrets/DB_PASSWORD + rt911-config
#                       (used by the positions COPY fast path)
set -euo pipefail

NS=video-grabber
TOKEN=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.DIRECTUS_API_TOKEN}' | base64 -d)
DB_PASSWORD=$(kubectl get secret -n rt911 rt911-secrets \
  -o jsonpath='{.data.DB_PASSWORD}' | base64 -d)
DB_USER=$(kubectl get cm -n rt911 rt911-config -o jsonpath='{.data.DB_USER}')
DB_DATABASE=$(kubectl get cm -n rt911 rt911-config -o jsonpath='{.data.DB_DATABASE}')
DSN="postgresql://${DB_USER}:${DB_PASSWORD}@rt911-db.rt911.svc.cluster.local:5432/${DB_DATABASE}"

kubectl create secret generic flight-recon-secrets -n "$NS" \
  --from-literal=DIRECTUS_API_TOKEN="$TOKEN" \
  --from-literal=RT911_DB_DSN="$DSN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "flight-recon-secrets applied in namespace $NS"
