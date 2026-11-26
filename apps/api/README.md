# Lingmao Media Studio — Backend API & Persistent Worker (`apps/api`)

FastAPI service, PostgreSQL transactional data layer, private object storage gateway, and persistent lease-based job worker implementing the Stage 4/5 Lingmao Media Studio contract (`/api/v1`).

## Prerequisites

- Python 3.11+
- PostgreSQL 15+ (local service `postgresql-x64-18` on `127.0.0.1:5432`, database `lingmao_studio`)
- `ffmpeg` on `PATH` (for H.264 `.mp4` short video generation in deterministic sandbox mode)

## Environment Configuration

Copy `.env.example` to a local `.env` (never commit `.env` or runtime storage files to Git):

```powershell
cd apps/api
Copy-Item .env.example .env
```

- `LINGMAO_DEMO_INFERENCE_ENABLED=true` and `LINGMAO_ENV_MODE=sandbox` explicitly enable the deterministic local inference adapter (`execution="demo"` in `GET /api/v1/models`). When disabled without live provider credentials, generation endpoints return `503 PROVIDER_UNAVAILABLE`.
- `LINGMAO_SANDBOX_BILLING_ENABLED=true` and `LINGMAO_ENV_MODE=sandbox` enable isolated sandbox checkout and signed webhook verification (`checkoutMode="sandbox"`). No real payment charges are ever triggered.
- P1 feature flags (`LINGMAO_FEATURE_VIRTUAL_TRYON`, `LINGMAO_FEATURE_ORG_COLLABORATION`, `LINGMAO_FEATURE_AUDIO_STUDIO`) default to `false` and return `404 FEATURE_DISABLED` on gated endpoints/modes.

## Database Migration & Startup Commands

```powershell
# 1. Run Alembic PostgreSQL migration
cd apps/api
python -m alembic upgrade head

# 2. Start the FastAPI server (Terminal 1)
cd apps/api
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3. Start the independent persistent Job Worker (Terminal 2)
cd apps/api
python -m app.worker
```
