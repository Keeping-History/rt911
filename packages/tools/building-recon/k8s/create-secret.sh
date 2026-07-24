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
#   DC_BUILDINGS_URL          ArcGIS FeatureServer query URL (must be set)
#   ARLINGTON_BUILDINGS_URL   ArcGIS FeatureServer query URL (must be set)
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

# DC and Arlington ArcGIS URLs must be configured explicitly (see README.md)
# Example: https://mapping.dcgis.dc.gov/arcgis/rest/services/...
DC_URL="${DC_BUILDINGS_URL:-}"
ARLINGTON_URL="${ARLINGTON_BUILDINGS_URL:-}"

if [ -z "$DC_URL" ] || [ -z "$ARLINGTON_URL" ]; then
  echo "ERROR: DC_BUILDINGS_URL and ARLINGTON_BUILDINGS_URL must be set as env vars"
  exit 1
fi

kubectl create secret generic building-recon-secrets -n "$NS" \
  --from-literal=DIRECTUS_API_TOKEN="$TOKEN" \
  --from-literal=WASABI_ENDPOINT_URL="$WASABI_ENDPOINT" \
  --from-literal=WASABI_BUCKET="$WASABI_BUCKET" \
  --from-literal=WASABI_ACCESS_KEY_ID="$WASABI_KEY_ID" \
  --from-literal=WASABI_SECRET_ACCESS_KEY="$WASABI_SECRET" \
  --from-literal=CF_API_TOKEN="$CF_TOKEN" \
  --from-literal=CF_ZONE_ID="$CF_ZONE" \
  --from-literal=DC_BUILDINGS_URL="$DC_URL" \
  --from-literal=ARLINGTON_BUILDINGS_URL="$ARLINGTON_URL" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "building-recon-secrets applied in namespace $NS"
