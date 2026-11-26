from __future__ import annotations

import os
import tempfile
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

KNOWN_EXAMPLE_SECRETS: frozenset[str] = frozenset(
    {
        "changeme",
        "secret",
        "example",
        "test",
        "default",
        "replace-me",
        "placeholder",
        "none",
        "null",
    }
)


def _default_storage_dir() -> str:
    candidate = Path("C:/Users/Administrator/orca/workspaces/lingmao-media-studio-work/backend-ecommerce/storage")
    if candidate.parent.exists():
        return str(candidate)
    return str(Path(tempfile.gettempdir()) / "lingmao-media-studio-storage")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LINGMAO_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/lingmao_studio"
    env_mode: str = "live"  # Defaults to "live"; must be explicitly set to "sandbox" for local demo/sandbox
    storage_dir: str = _default_storage_dir()

    # Sandbox/demo switches default to False and are only honored when env_mode == "sandbox"
    demo_inference_enabled: bool = False
    live_provider_url: str = ""
    live_provider_api_key: str = ""

    sandbox_billing_enabled: bool = False
    sandbox_otp_enabled: bool = False
    sandbox_otp_code: str = ""

    # Secrets must be injected from the environment; no hardcoded fallback values
    payment_merchant_id: str = ""
    payment_webhook_secret: str = ""
    generation_webhook_secret: str = ""
    sms_provider_url: str = ""

    # P1 Feature flags (default false in P0)
    feature_virtual_tryon: bool = False
    feature_org_collaboration: bool = False
    feature_audio_studio: bool = False

    initial_trial_credits: int = 100
    quote_ttl_seconds: int = 900
    max_upload_bytes: int = 50 * 1024 * 1024
    default_storage_limit_bytes: int = 2 * 1024 * 1024 * 1024
    default_max_concurrent_jobs: int = 4
    default_queue_limit: int = 24
    default_canvas_node_limit: int = 300
    default_max_canvas_count: int = 100
    worker_poll_interval_seconds: float = 0.5
    worker_lease_seconds: int = 30

    @property
    def is_demo_inference(self) -> bool:
        return bool(self.demo_inference_enabled and self.env_mode == "sandbox")

    @property
    def has_live_inference(self) -> bool:
        # Stage 5 implements only the deterministic demo adapter for sandbox integration.
        # Live cloud/ComfyUI provider drivers are not connected; filling config strings alone must not claim availability.
        return False

    @property
    def is_sandbox_billing(self) -> bool:
        return bool(self.sandbox_billing_enabled and self.env_mode == "sandbox")

    @property
    def has_live_billing(self) -> bool:
        # Stage 5 implements only sandbox billing verification.
        # Live merchant payment channels are not connected; filling merchant config alone must not claim live checkout.
        return False

    @property
    def checkout_mode(self) -> str:
        if self.has_live_billing:
            return "live"
        if self.is_sandbox_billing:
            return "sandbox"
        return "unavailable"

    @property
    def features_dict(self) -> dict[str, bool]:
        return {
            "virtual_tryon": bool(self.feature_virtual_tryon),
            "org_collaboration": bool(self.feature_org_collaboration),
            "audio_studio": bool(self.feature_audio_studio),
        }


def get_settings() -> Settings:
    return Settings()
