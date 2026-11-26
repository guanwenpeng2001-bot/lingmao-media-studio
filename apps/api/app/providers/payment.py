from __future__ import annotations

import hashlib
import hmac
from app.config import KNOWN_EXAMPLE_SECRETS, get_settings
from app.errors import AppError


def ensure_billing_available() -> str:
    settings = get_settings()
    mode = settings.checkout_mode
    if mode == "unavailable":
        raise AppError(
            503,
            "BILLING_UNAVAILABLE",
            "真实支付通道尚未接入，且当前未显式开启沙盒支付联调配置",
        )
    return mode


def _is_example_or_weak_secret(secret: str) -> bool:
    lower = secret.lower()
    if lower in KNOWN_EXAMPLE_SECRETS:
        return True
    if lower.startswith(("dev-", "example-", "test-", "placeholder-", "dummy-", "sample-")):
        return True
    if "webhook-secret" in lower or len(secret) < 16:
        return True
    return False


def validate_payment_webhook_secret() -> str:
    settings = get_settings()
    secret = (settings.payment_webhook_secret or "").strip()
    if not secret:
        raise AppError(
            503,
            "BILLING_UNAVAILABLE",
            "未配置支付回调验签密钥 (LINGMAO_PAYMENT_WEBHOOK_SECRET)，拒绝处理回调",
        )
    if _is_example_or_weak_secret(secret):
        if settings.env_mode == "live":
            raise AppError(
                503,
                "BILLING_UNAVAILABLE",
                "生产环境禁止使用已知示例或默认支付回调密钥",
            )
        raise AppError(
            400,
            "INVALID_SIGNATURE",
            "禁止使用已知示例支付回调密钥，请注入本地随机密钥",
        )
    return secret


def verify_payment_webhook_signature(raw_body: bytes, signature: str | None) -> bool:
    secret = validate_payment_webhook_secret()
    if not signature:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    provided = signature.removeprefix("sha256=").strip()
    return hmac.compare_digest(expected, provided)
