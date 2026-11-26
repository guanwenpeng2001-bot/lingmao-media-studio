from __future__ import annotations

import hashlib
import hmac
from app.config import get_settings
from app.errors import AppError


def ensure_billing_available() -> str:
    settings = get_settings()
    mode = settings.checkout_mode
    if mode == "unavailable":
        raise AppError(
            503,
            "BILLING_UNAVAILABLE",
            "未配置真实支付商户凭证，且未开启沙盒支付联调配置",
        )
    return mode


def verify_payment_webhook_signature(raw_body: bytes, signature: str | None) -> bool:
    settings = get_settings()
    if not signature or not settings.payment_webhook_secret:
        return False
    expected = hmac.new(settings.payment_webhook_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    provided = signature.removeprefix("sha256=").strip()
    return hmac.compare_digest(expected, provided)
