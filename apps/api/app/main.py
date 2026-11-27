from __future__ import annotations

from contextlib import asynccontextmanager
from urllib.parse import urlparse
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.assets.router import router as assets_router
from app.auth.router import router as auth_router
from app.billing.router import router as billing_router
from app.catalog.router import router as catalog_router
from app.config import get_settings
from app.db import Base, get_engine, get_session_factory
from app.errors import build_error_payload, get_request_id, register_error_handlers
from app.jobs.router import router as jobs_router
from app.projects.router import router as projects_router
from app.seed import seed_catalog_defaults


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = get_engine()
    Base.metadata.create_all(bind=engine)
    session_factory = get_session_factory()
    with session_factory() as db:
        seed_catalog_defaults(db)
    yield


def _extract_origin_candidate(raw_origin: str | None, raw_referer: str | None) -> str | None:
    candidate = (raw_origin or "").strip()
    if not candidate and raw_referer:
        candidate = raw_referer.strip()
    if not candidate:
        return None
    if candidate.lower() == "null":
        return "null"
    parsed = urlparse(candidate)
    if not parsed.scheme or not parsed.netloc:
        return "invalid"
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _resolve_expected_self_origin(request, trust_proxy: bool) -> str:
    scheme = request.url.scheme.lower()
    host = (request.headers.get("host") or request.url.netloc).strip().lower()
    if trust_proxy:
        fwd_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        fwd_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip().lower()
        if fwd_proto:
            scheme = fwd_proto
        if fwd_host:
            host = fwd_host
    return f"{scheme}://{host}"


def create_app() -> FastAPI:
    app = FastAPI(
        title="Lingmao Media Studio API",
        version="0.2.0",
        lifespan=lifespan,
    )

    settings = get_settings()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_error_handlers(app)

    @app.middleware("http")
    async def verify_mutating_request_origin(request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            path = request.url.path
            is_webhook = "/webhooks/" in path
            if not is_webhook:
                candidate = _extract_origin_candidate(
                    request.headers.get("origin"),
                    request.headers.get("referer"),
                )
                if candidate is not None:
                    cur_settings = get_settings()
                    self_origin = _resolve_expected_self_origin(
                        request, trust_proxy=bool(cur_settings.trust_proxy_headers)
                    )
                    if candidate in ("null", "invalid") or (
                        candidate not in cur_settings.allowed_origins_set
                        and candidate != self_origin
                    ):
                        req_id = get_request_id(request)
                        return JSONResponse(
                            status_code=403,
                            content=build_error_payload(
                                "FORBIDDEN",
                                "非授信请求来源 (Origin 校验未通过)",
                                req_id,
                            ),
                            headers={"X-Request-Id": req_id},
                        )
        return await call_next(request)

    prefix = "/api/v1"
    app.include_router(auth_router, prefix=prefix)
    app.include_router(projects_router, prefix=prefix)
    app.include_router(catalog_router, prefix=prefix)
    app.include_router(assets_router, prefix=prefix)
    app.include_router(jobs_router, prefix=prefix)
    app.include_router(billing_router, prefix=prefix)

    orig_openapi = app.openapi

    def custom_openapi():
        if app.openapi_schema:
            return app.openapi_schema
        schema = orig_openapi()
        confirm_op = (
            schema.get("paths", {})
            .get("/api/v1/billing/checkout-sessions/{checkoutId}/sandbox-confirm", {})
            .get("post")
        )
        if confirm_op:
            for param in confirm_op.get("parameters", []):
                if param.get("in") == "header" and param.get("name") == "Idempotency-Key":
                    param["required"] = True
                    param["schema"] = {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                    }
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]

    return app


app = create_app()
