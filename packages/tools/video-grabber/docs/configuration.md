# Configuration

All configuration is read from environment variables by [`video_grabber/config.py`](../video_grabber/config.py). There is no config file; the `.env.example` is the canonical reference for what to set locally and what the ConfigMap + Secret should contain in-cluster.

## Variables

| Variable | Default | Required in prod? | Read by |
| --- | --- | --- | --- |
| `DATABASE_URL` | `""` | Yes (Secret) | `pipeline/flows.py` via `Config` |
| `WASABI_ENDPOINT_URL` | `https://s3.us-central-1.wasabisys.com` | No (ConfigMap) | `storage/wasabi.py` |
| `WASABI_BUCKET` | `files.911realtime.org` | No (ConfigMap) | `storage/wasabi.py` |
| `WASABI_ACCESS_KEY_ID` | `""` | Yes (Secret) | `storage/wasabi.py` |
| `WASABI_SECRET_ACCESS_KEY` | `""` | Yes (Secret) | `storage/wasabi.py` |
| `DIRECTUS_URL` | `http://localhost:8055` | Yes (ConfigMap) | `directus/writer.py` |
| `DIRECTUS_API_TOKEN` | `""` | **Yes (Secret)** — must be a static token | `directus/writer.py` |
| `ADMIN_EMAIL` | `""` | No (unused by worker) | held in `Config` for manual scripts |
| `ADMIN_PASSWORD` | `""` | No (unused by worker) | held in `Config` for manual scripts |
| `IA_RATE_PER_SEC` | `2` | No (ConfigMap) | `pipeline/flows.py::scan_collections_flow` |
| `MIN_DURATION_SECONDS` | `720` | No (ConfigMap) | `ia/scanner.py` |
| `PREFECT_API_URL` | (none) | Yes (ConfigMap) | Prefect SDK (worker boot, not `Config`) |
| `SCRATCH_DIR` | `/tmp/vg-scratch` | No | `pipeline/flows.py` (module-level `_SCRATCH`) |
| `HOSTNAME` | (set by Kubernetes / OS) | No | `pipeline/flows.py::transition_job` |

## What goes in the Secret vs the ConfigMap

The worker manifest references both with `envFrom`:

```yaml
envFrom:
  - configMapRef:
      name: video-grabber-config
  - secretRef:
      name: video-grabber-secrets
```

The split is conventional:

- **ConfigMap** — anything operationally interesting (URLs, rate limits, thresholds) that's safe to read from `kubectl get configmap`.
- **Secret** — anything that grants access (credentials, API tokens, DB URLs).

`DATABASE_URL` is in the Secret rather than ConfigMap because it contains the Postgres password.

## Why a static Directus token, never email/password

[`directus/writer.py`](../video_grabber/directus/writer.py) only reads `cfg.directus_api_token`. The `ADMIN_EMAIL` / `ADMIN_PASSWORD` fields exist on `Config` for the benefit of manual maintenance scripts that need an admin session — they are not consumed by the worker.

The reason is concurrency: Directus session tokens are bound to a single login event and rotate. When two workers tried to use the same email/password they would each log in, invalidate the other's session, and one of every pair of writes would fail with 401. Static API tokens have no session state and are safe to share across N concurrent workers. The `.env.example` says so explicitly:

> Directus API — use a static token (never session tokens; they race across concurrent workers)

## Why `IA_RATE_PER_SEC=2`

Internet Archive's bulk-access guidelines cap automated callers at ~2 concurrent requests. The scanner sleeps `1 / IA_RATE_PER_SEC` between items (`pipeline/flows.py:90-91`). Raising this past 2 risks rate-limit IP bans. Lowering it slows down recrawls — for an initial scan of a 50k-item collection at 2/s that's roughly 7 hours, which is the budget.

## Why `MIN_DURATION_SECONDS=720`

12 minutes. Shorter IA items in these collections are almost always clips, promos, or test patterns rather than continuous broadcast coverage. The threshold matches the cutoff used in the legacy `packages/backend/seed.mjs` importer.

## Local development `.env`

Copy `.env.example` to `.env` in this directory. The file is already in `.gitignore`. Fill in real Wasabi credentials (or use a moto/localstack S3 — see the test config) and either a local Directus token or the dev cluster's Directus URL with a token scoped for development.

## Test environment

`pytest` does not require any env vars. The test suite stubs out `Config()`, mocks the IA SDK, mocks boto3 with `moto[s3]`, and mocks Directus HTTP with `respx`. See [testing.md](./testing.md).
