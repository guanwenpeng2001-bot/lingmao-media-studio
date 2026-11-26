# Lingmao Media Studio — Backend API & Persistent Worker (`apps/api`)

FastAPI service, PostgreSQL transactional data layer, private object storage gateway, and persistent lease-based job worker implementing the Stage 4/5 Lingmao Media Studio contract (`/api/v1`).

## Prerequisites

- Python 3.11+
- PostgreSQL 15+ (local service `postgresql-x64-18` on `127.0.0.1:5432`, database `lingmao_studio`)
- `ffmpeg` on `PATH` (for H.264 `.mp4` short video generation in deterministic sandbox mode)

## Environment Configuration

All sandbox/demo switches default to `false` (`LINGMAO_ENV_MODE=live`), and webhook signature secrets (`LINGMAO_PAYMENT_WEBHOOK_SECRET`, `LINGMAO_GENERATION_WEBHOOK_SECRET`) have **no hardcoded defaults**—they must be injected via environment variables.

To initialize a local sandbox `.env` safely (never commit `.env` or runtime storage files to Git):

```powershell
cd apps/api
Copy-Item .env.example .env

# Generate random local HMAC secrets and explicitly opt in to local sandbox mode:
$paySecret = python -c "import secrets; print(secrets.token_hex(32))"
$genSecret = python -c "import secrets; print(secrets.token_hex(32))"
Add-Content .env "`nLINGMAO_ENV_MODE=sandbox"
Add-Content .env "LINGMAO_DEMO_INFERENCE_ENABLED=true"
Add-Content .env "LINGMAO_SANDBOX_BILLING_ENABLED=true"
Add-Content .env "LINGMAO_SANDBOX_OTP_ENABLED=true"
Add-Content .env "LINGMAO_SANDBOX_OTP_CODE=123456"
Add-Content .env "LINGMAO_PAYMENT_WEBHOOK_SECRET=$paySecret"
Add-Content .env "LINGMAO_GENERATION_WEBHOOK_SECRET=$genSecret"
```

- **Explicit Sandbox / Demo Opt-In**: `LINGMAO_DEMO_INFERENCE_ENABLED`, `LINGMAO_SANDBOX_BILLING_ENABLED`, and `LINGMAO_SANDBOX_OTP_ENABLED` are `false` by default and take effect **only** when `LINGMAO_ENV_MODE=sandbox`.
- **Webhook Secret Isolation**: If `LINGMAO_PAYMENT_WEBHOOK_SECRET` or `LINGMAO_GENERATION_WEBHOOK_SECRET` is missing, empty, or set to a known example placeholder, webhook callbacks are rejected before any database, ledger, asset, or job state mutation occurs.
- **Honest Live Channel Status**: Stage 5 implements the `sandbox`/`demo` adapters only (`live_inference_driver_connected=False`, `live_billing_driver_connected=False`, `live_sms_driver_connected=False`). Merely populating `LINGMAO_LIVE_PROVIDER_URL` or `LINGMAO_PAYMENT_MERCHANT_ID` does not falsely report live availability; in `live` mode or when sandbox switches are off, generation, checkout, and OTP fail cleanly with `503 PROVIDER_UNAVAILABLE` / `503 BILLING_UNAVAILABLE`.
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
