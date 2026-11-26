from __future__ import annotations

from app.config import get_settings
from app.errors import AppError


def send_otp_code(phone: str) -> str:
    settings = get_settings()
    if settings.env_mode == "sandbox" and settings.sandbox_otp_enabled:
        return settings.sandbox_otp_code
    if not settings.sms_provider_url:
        raise AppError(
            503,
            "PROVIDER_UNAVAILABLE",
            "未配置短信服务提供商凭证，且未启用联调沙盒验证码",
        )
    raise AppError(503, "PROVIDER_UNAVAILABLE", "生产短信网关未连接")
