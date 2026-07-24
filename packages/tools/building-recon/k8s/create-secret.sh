#!/usr/bin/env bash
# Create/refresh the building-recon-secrets Secret, entirely server-side — no
# credential is ever written to disk or committed.
#   DIRECTUS_API_TOKEN        copied from video-grabber-secrets
#   WASABI_ENDPOINT_URL       copied from video-grabber-secrets
#   WASABI_BUCKET             copied from video-grabber-secrets
#   WASABI_ACCESS_KEY_ID      copied from video-grabber-secrets
#   WASABI_SECRET_ACCESS_KEY  copied from video-grabber-secrets
#   CF_API_TOKEN              copied from video-grabber-secrets
#   CF_ZONE_ID                copied from video-grabber-secrets
# (Source URLs — NYC Socrata, Arlington ArcGIS — are hardcoded in sources.py.)
set -euo pipefail

NS=video-grabber
TOKEN=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.DIRECTUS_API_TOKEN}' | base64 -d)
WASABI_ENDPOINT=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.WASABI_ENDPOINT_URL}' | base64 -d)
WASABI_BUCKET=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.WASABI_BUCKET}' | base64 -d)
WASABI_KEY_ID=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.WASABI_ACCESS_KEY_ID}' | base64 -d)
WASABI_SECRET=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.WASABI_SECRET_ACCESS_KEY}' | base64 -d)
CF_TOKEN=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.CF_API_TOKEN}' | base64 -d)
CF_ZONE=$(kubectl get secret -n "$NS" video-grabber-secrets \
  -o jsonpath='{.data.CF_ZONE_ID}' | base64 -d)

kubectl create secret generic building-recon-secrets -n "$NS" \
  --from-literal=DIRECTUS_API_TOKEN="$TOKEN" \
  --from-literal=WASABI_ENDPOINT_URL="$WASABI_ENDPOINT" \
  --from-literal=WASABI_BUCKET="$WASABI_BUCKET" \
  --from-literal=WASABI_ACCESS_KEY_ID="$WASABI_KEY_ID" \
  --from-literal=WASABI_SECRET_ACCESS_KEY="$WASABI_SECRET" \
  --from-literal=CF_API_TOKEN="$CF_TOKEN" \
  --from-literal=CF_ZONE_ID="$CF_ZONE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "building-recon-secrets applied in namespace $NS"
