from __future__ import annotations

import uuid
from typing import Any
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def get_request_id(request: Request) -> str:
    req_id = getattr(request.state, "request_id", None)
    if not req_id:
        req_id = request.headers.get("X-Request-Id") or f"req-{uuid.uuid4().hex[:16]}"
        request.state.request_id = req_id
    return req_id


def build_error_payload(
    code: str,
    message: str,
    request_id: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    err: dict[str, Any] = {
        "code": code,
        "message": message,
        "requestId": request_id,
    }
    if details is not None:
        err["details"] = details
    return {"error": err}


def register_error_handlers(app: FastAPI) -> None:
    @app.middleware("http")
    async def attach_request_id(request: Request, call_next):
        req_id = get_request_id(request)
        response = await call_next(request)
        response.headers["X-Request-Id"] = req_id
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        req_id = get_request_id(request)
        return JSONResponse(
            status_code=exc.status_code,
            content=build_error_payload(exc.code, exc.message, req_id, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        req_id = get_request_id(request)
        path = request.url.path
        code = "INVALID_GRAPH" if "/canvases/" in path and request.method in ("PUT", "POST") else "INVALID_INPUT"
        clean_errors = []
        for err in exc.errors():
            clean_errors.append(
                {
                    "loc": [str(x) for x in err.get("loc", [])],
                    "msg": str(err.get("msg", "validation error")),
                    "type": str(err.get("type", "value_error")),
                }
            )
        return JSONResponse(
            status_code=422,
            content=build_error_payload(
                code=code,
                message="请求参数校验未通过",
                request_id=req_id,
                details={"validationErrors": clean_errors},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        req_id = get_request_id(request)
        code_map = {
            400: "BAD_REQUEST",
            401: "UNAUTHENTICATED",
            403: "FORBIDDEN",
            404: "NOT_FOUND",
            409: "CONFLICT",
            410: "GONE",
            413: "PAYLOAD_TOO_LARGE",
            415: "UNSUPPORTED_MEDIA",
            422: "INVALID_INPUT",
            429: "RATE_LIMIT",
            503: "PROVIDER_UNAVAILABLE",
        }
        code = code_map.get(exc.status_code, "HTTP_ERROR")
        msg = str(exc.detail) if exc.detail else code
        return JSONResponse(
            status_code=exc.status_code,
            content=build_error_payload(code=code, message=msg, request_id=req_id),
        )

    @app.exception_handler(Exception)
    async def handle_unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
        req_id = get_request_id(request)
        return JSONResponse(
            status_code=500,
            content=build_error_payload(
                code="INTERNAL_ERROR",
                message=f"Internal server error: {type(exc).__name__}",
                request_id=req_id,
            ),
        )
