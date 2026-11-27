# lingmao-media-studio

Lingmao Media Studio — Multimodal Image & Video Generation Workbench (灵猫互娱图片/视频多模态生成工作台).

## Branching Policy

- `main`: Protected release branch. Do not commit directly to `main`.
- `dev`: Primary integration development branch.

## Container Deployment (Docker Compose)

Copy the root environment template and configure required secrets before starting:

```bash
cp .env.example .env
```

### Production / Default (Fail-Closed `live` Mode)

`docker-compose.yml` starts `postgres`, `migrate`, `api`, `worker`, and `web` (Nginx on port `${WEB_PORT:-8080}`). Sandbox switches default to `false` and webhook secrets must be injected via environment variables:

```bash
docker compose up -d --build
```

### Local Sandbox Smoke Mode (Opt-In)

Combine `docker-compose.sandbox.yml` explicitly and supply ephemeral secrets via host environment variables (never hardcode secrets in Compose files):

```bash
LINGMAO_SANDBOX_OTP_CODE=123456 \
LINGMAO_PAYMENT_WEBHOOK_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')" \
LINGMAO_GENERATION_WEBHOOK_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')" \
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
```

Open `http://localhost:8080`. To stop and remove volumes:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml down -v
```

## CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs on pushes and pull requests to `dev` and `main`:

- `web-ci`: `npm ci`, `npm run typecheck`, `npm run build`, and `npm test` in `apps/web`.
- `api-ci`: installs `ffmpeg`, compiles `app`, verifies the 55-path OpenAPI contract (`Idempotency-Key` required on `sandbox-confirm`), and runs `pytest` in `apps/api`.
- `docker-ci`: validates Compose configs and fail-closed defaults, builds both images, verifies `ffmpeg` inside the API image, and runs an end-to-end smoke check through Nginx against Postgres, Migrate, API, and Worker.
