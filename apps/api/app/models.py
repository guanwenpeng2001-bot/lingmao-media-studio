from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    JSON,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.db import Base

JSONB = JSON().with_variant(PG_JSONB(), "postgresql")


class TzDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value

    def process_result_value(self, value: datetime | None, dialect):
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


# Replace DateTime(timezone=True) with TzDateTime for transparent timezone awareness across dialects
def DateTime(timezone: bool = True):  # type: ignore[no-redef]
    return TzDateTime()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    phone_lookup: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    phone_ciphertext: Mapped[str] = mapped_column(String(256), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class AuthChallenge(Base):
    __tablename__ = "auth_challenges"
    __table_args__ = (
        Index("ix_auth_challenges_phone_expires", "phone_lookup", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    phone_lookup: Mapped[str] = mapped_column(String(128), nullable=False)
    code_digest: Mapped[str] = mapped_column(String(128), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Workspace(Base):
    __tablename__ = "workspaces"
    __table_args__ = (
        Index(
            "uq_workspaces_personal_owner",
            "owner_user_id",
            unique=True,
            postgresql_where=text("kind = 'personal'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # personal | team
    owner_user_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    event_cursor: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    permission_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Member(Base):
    __tablename__ = "members"
    __table_args__ = (
        Index("ix_members_user_status", "user_id", "status"),
    )

    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False)  # owner | editor | viewer
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)  # active | revoked
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class WorkspaceInvitation(Base):
    __tablename__ = "workspace_invitations"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    token_digest: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_by: Mapped[str | None] = mapped_column(String(128), ForeignKey("users.id"), nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class UserSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        Index("ix_sessions_user_expires", "user_id", "expires_at"),
    )

    token_digest: Mapped[str] = mapped_column(String(128), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id", name="uq_projects_workspace_id"),
        Index("ix_projects_workspace_status_updated", "workspace_id", "status", "updated_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    industry: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)  # active | archived
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_by: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ProjectGrantRecord(Base):
    __tablename__ = "project_grants"

    project_id: Mapped[str] = mapped_column(String(128), ForeignKey("projects.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)  # editor | viewer
    allow_copy: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    allow_download: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CanvasRecord(Base):
    __tablename__ = "canvases"
    __table_args__ = (
        UniqueConstraint("workspace_id", "project_id", "id", name="uq_canvases_ws_prj_id"),
        ForeignKeyConstraint(["workspace_id", "project_id"], ["projects.workspace_id", "projects.id"]),
        Index("ix_canvases_ws_prj_status_updated", "workspace_id", "project_id", "status", "updated_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)  # active | completed | archived
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    node_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cover_asset_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_by: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CanvasVisit(Base):
    __tablename__ = "canvas_visits"
    __table_args__ = (
        Index("ix_canvas_visits_user_ws_seen", "user_id", "workspace_id", "seen_at"),
    )

    user_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), primary_key=True)
    canvas_id: Mapped[str] = mapped_column(String(128), ForeignKey("canvases.id"), primary_key=True)
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CanvasAssetRef(Base):
    __tablename__ = "canvas_asset_refs"
    __table_args__ = (
        Index("ix_canvas_asset_refs_ws_asset", "workspace_id", "asset_id"),
    )

    canvas_id: Mapped[str] = mapped_column(String(128), ForeignKey("canvases.id"), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(128), ForeignKey("assets.id"), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), nullable=False)


class TemplateRecord(Base):
    __tablename__ = "templates"
    __table_args__ = (
        Index("ix_templates_scope_ws_industry", "scope", "workspace_id", "industry"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    scope: Mapped[str] = mapped_column(String(32), nullable=False)  # official | personal | team
    workspace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    industry: Mapped[str] = mapped_column(String(64), nullable=False)
    prompt: Mapped[str] = mapped_column(Text, default="", nullable=False)
    suggested_modes: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    aspect_ratio: Mapped[str] = mapped_column(String(16), default="1:1", nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ModelCatalogRecord(Base):
    __tablename__ = "model_catalog"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    modes: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    aspect_ratios: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    duration_seconds: Mapped[list[int]] = mapped_column(JSONB, default=list, nullable=False)
    max_input_images: Mapped[int] = mapped_column(Integer, default=4, nullable=False)
    max_input_clips: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    resolutions: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    native_audio: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    supports_last_frame: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    supports_locked_subject: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    submission_recovery: Mapped[str] = mapped_column(String(32), default="idempotent_key", nullable=False)
    pricing_version: Mapped[str] = mapped_column(String(128), default="test-rate-v1", nullable=False)
    base_credits: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    availability: Mapped[str] = mapped_column(String(32), default="available", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class PlatformPresetRecord(Base):
    __tablename__ = "platform_presets"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    platform: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    aspect_ratio: Mapped[str] = mapped_column(String(16), nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    safe_area: Mapped[dict[str, float]] = mapped_column(JSONB, nullable=False)


class AssetRecord(Base):
    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("workspace_id", "project_id", "id", name="uq_assets_ws_prj_id"),
        UniqueConstraint("source_job_id", "output_index", name="uq_assets_source_job_output"),
        ForeignKeyConstraint(["workspace_id", "project_id"], ["projects.workspace_id", "projects.id"]),
        Index("ix_assets_ws_prj_state_created", "workspace_id", "project_id", "state", "created_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    media_kind: Mapped[str] = mapped_column(String(32), nullable=False)  # image | video | audio
    asset_role: Mapped[str] = mapped_column(String(32), nullable=False)  # reference | mask | product | scene | poster | clip | other
    origin: Mapped[str] = mapped_column(String(32), nullable=False)  # upload | generated
    state: Mapped[str] = mapped_column(String(32), default="ready", nullable=False)  # ready | archived
    source_job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    output_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, default=dict, nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class AssetInputRecord(Base):
    __tablename__ = "asset_inputs"
    __table_args__ = (
        Index("ix_asset_inputs_input_asset_id", "input_asset_id"),
    )

    output_asset_id: Mapped[str] = mapped_column(String(128), ForeignKey("assets.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    input_asset_id: Mapped[str] = mapped_column(String(128), ForeignKey("assets.id"), nullable=False)


class AssetVariantRecord(Base):
    __tablename__ = "asset_variants"
    __table_args__ = (
        UniqueConstraint("asset_id", "kind", "policy_version", name="uq_asset_variants_asset_kind_policy"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    asset_id: Mapped[str] = mapped_column(String(128), ForeignKey("assets.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # preview | watermarked | clean
    policy_version: Mapped[str] = mapped_column(String(64), nullable=False)
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class SubjectRecord(Base):
    __tablename__ = "subjects"
    __table_args__ = (
        ForeignKeyConstraint(["workspace_id", "project_id"], ["projects.workspace_id", "projects.id"]),
        Index(
            "uq_subjects_project_sku",
            "project_id",
            "sku",
            unique=True,
            postgresql_where=text("sku IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    current_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class SubjectVersionRecord(Base):
    __tablename__ = "subject_versions"

    subject_id: Mapped[str] = mapped_column(String(128), ForeignKey("subjects.id"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    primary_asset_id: Mapped[str] = mapped_column(String(128), ForeignKey("assets.id"), nullable=False)
    mask_asset_id: Mapped[str | None] = mapped_column(String(128), ForeignKey("assets.id"), nullable=True)
    references_json: Mapped[list[str]] = mapped_column("references", JSONB, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class PortraitCatalogRecord(Base):
    __tablename__ = "portrait_catalog"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    preview_asset: Mapped[str] = mapped_column(String(256), nullable=False)
    license_version: Mapped[str] = mapped_column(String(128), nullable=False)
    allowed_uses: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    attributes: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)


class PortraitConsentRecord(Base):
    __tablename__ = "portrait_consents"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), ForeignKey("projects.id"), nullable=False)
    asset_id: Mapped[str] = mapped_column(String(128), ForeignKey("assets.id"), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    terms_version: Mapped[str] = mapped_column(String(128), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class QuoteRecord(Base):
    __tablename__ = "quotes"
    __table_args__ = (
        Index("ix_quotes_workspace_expires", "workspace_id", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), ForeignKey("projects.id"), nullable=False)
    canvas_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_by: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # single | batch | graph
    pricing_version: Mapped[str] = mapped_column(String(128), nullable=False)
    frozen_request: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    canvas_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_credits: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class QuoteItemRecord(Base):
    __tablename__ = "quote_items"
    __table_args__ = (
        UniqueConstraint("quote_id", "ordinal", name="uq_quote_items_quote_ordinal"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    quote_id: Mapped[str] = mapped_column(String(128), ForeignKey("quotes.id"), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    node_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    aspect_ratio: Mapped[str | None] = mapped_column(String(16), nullable=True)
    input_bindings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    cost: Mapped[int] = mapped_column(BigInteger, nullable=False)


class RunRecord(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), ForeignKey("projects.id"), nullable=False)
    canvas_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    base_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # batch | graph
    quote_id: Mapped[str] = mapped_column(String(128), ForeignKey("quotes.id"), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="running", nullable=False)  # running | succeeded | partial | failed | cancelled
    graph_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class RunStepRecord(Base):
    __tablename__ = "run_steps"
    __table_args__ = (
        UniqueConstraint("run_id", "quote_item_id", name="uq_run_steps_run_quote_item"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(128), ForeignKey("runs.id"), nullable=False)
    node_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    quote_item_id: Mapped[str] = mapped_column(String(128), ForeignKey("quote_items.id"), nullable=False)
    state: Mapped[str] = mapped_column(String(32), default="waiting", nullable=False)
    input_bindings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    depends_on: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)


class JobRecord(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_ws_prj_created", "workspace_id", "project_id", "created_at", "id"),
        Index("ix_jobs_ready_queue", "state", "priority", "not_before", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(String(128), ForeignKey("projects.id"), nullable=False)
    quote_item_id: Mapped[str] = mapped_column(String(128), ForeignKey("quote_items.id"), unique=True, nullable=False)
    run_id: Mapped[str | None] = mapped_column(String(128), ForeignKey("runs.id"), nullable=True)
    batch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    canvas_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    node_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    retry_of_job_id: Mapped[str | None] = mapped_column(String(128), ForeignKey("jobs.id"), nullable=True)
    state: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)  # queued | running | succeeded | failed | cancelled
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    frozen_input: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    result_refs: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    not_before: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ProviderDispatchRecord(Base):
    __tablename__ = "provider_dispatches"
    __table_args__ = (
        UniqueConstraint("job_id", "attempt", name="uq_provider_dispatches_job_attempt"),
        UniqueConstraint("provider", "dispatch_key", name="uq_provider_dispatches_provider_key"),
        Index(
            "uq_provider_dispatches_provider_job_id",
            "provider",
            "provider_job_id",
            unique=True,
            postgresql_where=text("provider_job_id IS NOT NULL"),
        ),
        Index("ix_provider_dispatches_poll", "state", "next_poll_at", "lease_until"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    job_id: Mapped[str] = mapped_column(String(128), ForeignKey("jobs.id"), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    dispatch_key: Mapped[str] = mapped_column(String(128), nullable=False)
    provider_job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_epoch: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    state: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    next_poll_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProviderInboxRecord(Base):
    __tablename__ = "provider_inbox"

    provider: Mapped[str] = mapped_column(String(64), primary_key=True)
    event_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    provider_job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    payload_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    body: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class JobEventRecord(Base):
    __tablename__ = "job_events"
    __table_args__ = (
        UniqueConstraint("job_id", "revision", name="uq_job_events_job_revision"),
    )

    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    job_id: Mapped[str] = mapped_column(String(128), ForeignKey("jobs.id"), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class RequestKeyRecord(Base):
    __tablename__ = "request_keys"

    workspace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    operation: Mapped[str] = mapped_column(String(64), primary_key=True)
    resource_scope: Mapped[str] = mapped_column(String(128), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    body_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(128), nullable=False)
    response_code: Mapped[int] = mapped_column(Integer, nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class OfferRecord(Base):
    __tablename__ = "offers"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)  # subscription | credit_pack
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    interval: Mapped[str | None] = mapped_column(String(32), nullable=True)  # month | quarter | year
    currency: Mapped[str] = mapped_column(String(3), default="CNY", nullable=False)
    price_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    credits: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_in_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    limits: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class OrderRecord(Base):
    __tablename__ = "orders"
    __table_args__ = (
        Index(
            "uq_orders_provider_trade_id",
            "provider",
            "provider_trade_id",
            unique=True,
            postgresql_where=text("provider_trade_id IS NOT NULL"),
        ),
        Index("ix_orders_workspace_state_expires", "workspace_id", "state", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    actor: Mapped[str] = mapped_column(String(128), ForeignKey("users.id"), nullable=False)
    offer_id: Mapped[str] = mapped_column(String(128), nullable=False)
    offer_version: Mapped[str] = mapped_column(String(64), nullable=False)
    item_type: Mapped[str] = mapped_column(String(32), nullable=False)  # subscription | credit_pack
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)  # live | sandbox
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="CNY", nullable=False)
    state: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)  # pending | paid | cancelled | expired
    provider_trade_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    redirect_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class BillingInboxRecord(Base):
    __tablename__ = "billing_inbox"

    provider: Mapped[str] = mapped_column(String(64), primary_key=True)
    environment: Mapped[str] = mapped_column(String(32), primary_key=True)
    event_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SubscriptionRecord(Base):
    __tablename__ = "subscriptions"
    __table_args__ = (
        Index("ix_subscriptions_state_period_end", "state", "period_end"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), unique=True, nullable=False)
    plan_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    provider_sub_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    offer_version: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(32), default="none", nullable=False)  # none | trialing | active | past_due | expired | pending
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CreditLotRecord(Base):
    __tablename__ = "credit_lots"
    __table_args__ = (
        UniqueConstraint("workspace_id", "grant_key", name="uq_credit_lots_workspace_grant_key"),
        Index("ix_credit_lots_workspace_expires_id", "workspace_id", "expires_at", "id"),
        CheckConstraint(
            "available >= 0 AND held >= 0 AND spent >= 0 AND expired >= 0 "
            "AND available + held + spent + expired = original_credits",
            name="ck_credit_lots_conservation",
        ),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)  # trial | subscription | pack
    grant_key: Mapped[str] = mapped_column(String(128), nullable=False)
    original_credits: Mapped[int] = mapped_column(BigInteger, nullable=False)
    available: Mapped[int] = mapped_column(BigInteger, nullable=False)
    held: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    spent: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    expired: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ReservationRecord(Base):
    __tablename__ = "reservations"
    __table_args__ = (
        Index(
            "uq_reservations_job_id",
            "job_id",
            unique=True,
            postgresql_where=text("job_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    quote_item_id: Mapped[str] = mapped_column(String(128), ForeignKey("quote_items.id"), unique=True, nullable=False)
    job_id: Mapped[str | None] = mapped_column(String(128), ForeignKey("jobs.id"), nullable=True)
    state: Mapped[str] = mapped_column(String(32), default="held", nullable=False)  # held | captured | released
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    actual: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class AllocationRecord(Base):
    __tablename__ = "allocations"
    __table_args__ = (
        CheckConstraint(
            "amount >= 0 AND captured >= 0 AND released >= 0 AND captured + released <= amount",
            name="ck_allocations_bounds",
        ),
    )

    reservation_id: Mapped[str] = mapped_column(String(128), ForeignKey("reservations.id"), primary_key=True)
    lot_id: Mapped[str] = mapped_column(String(128), ForeignKey("credit_lots.id"), primary_key=True)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    captured: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    released: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)


class CreditLedgerRecord(Base):
    __tablename__ = "credit_ledger"
    __table_args__ = (
        UniqueConstraint("workspace_id", "lot_id", "event_key", name="uq_credit_ledger_ws_lot_event"),
        Index("ix_credit_ledger_ws_created", "workspace_id", "created_at", "id"),
        Index("ix_credit_ledger_reservation_id", "reservation_id"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), nullable=False)
    lot_id: Mapped[str] = mapped_column(String(128), ForeignKey("credit_lots.id"), nullable=False)
    reservation_id: Mapped[str | None] = mapped_column(String(128), ForeignKey("reservations.id"), nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    order_id: Mapped[str | None] = mapped_column(String(128), ForeignKey("orders.id"), nullable=True)
    event_key: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # grant | hold | capture | release | expire
    available_delta: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    held_delta: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    spent_delta: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    expired_delta: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class WorkspaceUsageRecord(Base):
    __tablename__ = "workspace_usage"
    __table_args__ = (
        CheckConstraint(
            "active_jobs >= 0 AND queued_jobs >= 0 AND used_bytes >= 0 AND pending_bytes >= 0",
            name="ck_workspace_usage_non_negative",
        ),
    )

    workspace_id: Mapped[str] = mapped_column(String(128), ForeignKey("workspaces.id"), primary_key=True)
    active_jobs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    queued_jobs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    used_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    pending_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
