from __future__ import annotations

from app.config import get_settings
from app.errors import AppError


def send_otp_code(phone: str) -> str:
    settings = get_settings()
    if settings.env_mode == "sandbox" and settings.sandbox_otp_enabled:
        code = (settings.sandbox_otp_code or "").strip()
        if not code:
            raise AppError(
                503,
                "PROVIDER_UNAVAILABLE",
                "沙盒验证码未配置 LINGMAO_SANDBOX_OTP_CODE",
            )
        return code
    raise AppError(
        503,
        "PROVIDER_UNAVAILABLE",
        "真实短信通道尚未接入，且未显式启用联调沙盒验证码",
    )
