FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Install ffmpeg for free-tier video watermarking (fail-closed without ffmpeg in PATH)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY apps/api/alembic.ini /app/alembic.ini
COPY apps/api/migrations /app/migrations
COPY apps/api/app /app/app

# Create non-root runtime user and pre-create writable storage directory for named volume ownership
RUN groupadd --gid 10001 --system lingmao \
    && useradd --uid 10001 --gid lingmao --system --home-dir /app --shell /usr/sbin/nologin lingmao \
    && mkdir -p /data/storage \
    && chown -R lingmao:lingmao /app /data/storage \
    && chmod 775 /data/storage

USER lingmao

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
