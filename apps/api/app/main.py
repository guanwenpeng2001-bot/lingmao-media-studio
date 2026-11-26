from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.assets.router import router as assets_router
from app.auth.router import router as auth_router
from app.billing.router import router as billing_router
from app.catalog.router import router as catalog_router
from app.db import Base, get_engine, get_session_factory
from app.errors import register_error_handlers
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


def create_app() -> FastAPI:
    app = FastAPI(
        title="Lingmao Media Studio API",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_error_handlers(app)

    prefix = "/api/v1"
    app.include_router(auth_router, prefix=prefix)
    app.include_router(projects_router, prefix=prefix)
    app.include_router(catalog_router, prefix=prefix)
    app.include_router(assets_router, prefix=prefix)
    app.include_router(jobs_router, prefix=prefix)
    app.include_router(billing_router, prefix=prefix)

    return app


app = create_app()
