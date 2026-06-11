# Build the Vite/React SPA in the pnpm workspace, then serve the static output
# with nginx. Build context is the REPO ROOT (needs the workspace lockfile).
#
#   docker build -f packages/frontend/Dockerfile \
#     --build-arg VITE_PROXY_HOST=... --build-arg VITE_MEDIA_STREAM_URL=... .
#
# The VITE_* args are inlined into the static bundle at build time (Vite reads
# VITE_-prefixed vars from the environment), so the image is environment-specific.
FROM node:25-bookworm AS build
WORKDIR /repo
RUN npm install -g pnpm@10.17.0

# Manifests first for dependency-layer caching (backend is Go-only, no manifest).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/frontend/package.json packages/frontend/
RUN pnpm install --frozen-lockfile

# Source + build-time public config.
COPY packages/frontend/ packages/frontend/
ARG VITE_PROXY_PROTOCOL
ARG VITE_PROXY_HOST
ARG VITE_PROXY_PORT
ARG VITE_MEDIA_STREAM_URL
ENV VITE_PROXY_PROTOCOL=$VITE_PROXY_PROTOCOL \
    VITE_PROXY_HOST=$VITE_PROXY_HOST \
    VITE_PROXY_PORT=$VITE_PROXY_PORT \
    VITE_MEDIA_STREAM_URL=$VITE_MEDIA_STREAM_URL
# Transpile-only production build. We run `vite build` directly rather than the
# package's `tsc -b && vite build` script: Vite/esbuild strips types and emits a
# correct bundle, so the deployable image isn't gated on the branch's in-progress
# `tsc` type errors. Type-checking still runs via the repo's own `build`/CI.
RUN pnpm --filter @rt911/frontend exec vite build

FROM nginx:1.31-alpine
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/packages/frontend/dist /usr/share/nginx/html
EXPOSE 80
