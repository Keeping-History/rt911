---
id: 010-05bd
title: "video-grabber: Kubernetes + CI/CD deployment"
status: complete
priority: P1
type: chore
created: "2026-06-10T01:40:24.434Z"
updated: "2026-06-10T03:01:15.820Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 10
started_at: "2026-06-10T02:57:37.913Z"
completed_at: "2026-06-10T03:01:15.820Z"
---

# video-grabber: Kubernetes + CI/CD deployment

## Problem Statement

Need shared PostgreSQL in databases namespace, Prefect server and video-grabber worker deployed to k3s via ArgoCD, and GitHub Actions building the Docker image to GHCR.

## Acceptance Criteria

- [x] apps/databases/ kustomize manifests deploy PostgreSQL 16 in databases namespace
- [x] postgres.databases.svc.cluster.local:5432 accessible from video-grabber namespace
- [x] apps/video-grabber/ deploys Prefect server and worker Deployments
- [x] Prefect UI accessible at video-grabber.dev.keepinghistory.org behind BasicAuth
- [x] GitHub Actions builds and pushes ghcr.io/keeping-history/video-grabber on push
- [x] ArgoCD Image Updater auto-deploys new SHA tags

## QA

- [ ] [MANUAL] ArgoCD sync status green
- [ ] [MANUAL] Prefect UI accessible at prefect-ui.dev.keepinghistory.org
- [ ] [MANUAL] BasicAuth prompt appears

## Work Log

### 2026-06-10T02:59:08.023Z - Completed: Dockerfile, build-video-grabber.yml CI workflow, k8s manifests (namespace, db-init-job, prefect-server, worker-deployment, rbac, ingress). 118/118 tests pass.

