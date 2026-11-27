from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import (
    CreditLedgerRecord,
    CreditLotRecord,
    Member,
    Project,
    ProjectGrantRecord,
    RequestKeyRecord,
    SubscriptionRecord,
    User,
    UserSession,
    Workspace,
    WorkspaceUsageRecord,
    utcnow,
)

SESSION_COOKIE_NAME = "studio_session"


def sha256_hex(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def canonical_digest(payload: Any) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_hex(serialized)


@dataclass
class AuthContext:
    user: User
    workspace: Workspace
    member: Member
    session: UserSession

    @property
    def user_id(self) -> str:
        return self.user.id

    @property
    def workspace_id(self) -> str:
        return self.workspace.id

    @property
    def role(self) -> str:
        return self.member.role


def _extract_token(request: Request) -> str | None:
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token:
        return cookie_token.strip()
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    header_token = request.headers.get("X-Studio-Session")
    if header_token:
        return header_token.strip()
    return None


def get_optional_context(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthContext | None:
    raw_token = _extract_token(request)
    if not raw_token:
        return None
    token_digest = sha256_hex(raw_token)
    sess = db.get(UserSession, token_digest)
    now = utcnow()
    if not sess or sess.revoked_at is not None or sess.expires_at <= now:
        return None
    user = db.get(User, sess.user_id)
    workspace = db.get(Workspace, sess.workspace_id)
    member = db.get(Member, (sess.workspace_id, sess.user_id))
    if not user or not workspace or not member or member.status != "active":
        return None
    return AuthContext(user=user, workspace=workspace, member=member, session=sess)


def get_current_context(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthContext:
    raw_token = _extract_token(request)
    if not raw_token:
        raise AppError(401, "UNAUTHENTICATED", "未登录或缺少会话凭证")
    token_digest = sha256_hex(raw_token)
    sess = db.get(UserSession, token_digest)
    now = utcnow()
    if not sess or sess.revoked_at is not None or sess.expires_at <= now:
        raise AppError(401, "UNAUTHENTICATED", "会话已失效或已注销")
    user = db.get(User, sess.user_id)
    workspace = db.get(Workspace, sess.workspace_id)
    member = db.get(Member, (sess.workspace_id, sess.user_id))
    if not user or not workspace:
        raise AppError(401, "UNAUTHENTICATED", "用户或工作空间不存在")
    if not member or member.status != "active":
        raise AppError(403, "READ_ONLY", "当前工作空间访问权限已被撤销")
    return AuthContext(user=user, workspace=workspace, member=member, session=sess)


def get_effective_project_permissions(
    db: Session,
    ctx: AuthContext,
    project_id: str,
) -> tuple[str, bool, bool]:
    role = ctx.role
    allow_copy = role != "viewer"
    allow_download = role != "viewer"
    grant = db.get(ProjectGrantRecord, (project_id, ctx.user_id))
    if grant is not None:
        if role != "owner":
            role = grant.role
            allow_copy = grant.allow_copy
            allow_download = grant.allow_download
    return role, allow_copy, allow_download


def require_project_access(
    db: Session,
    ctx: AuthContext,
    project_id: str,
    write: bool = False,
) -> Project:
    project = db.scalar(
        select(Project).where(
            Project.id == project_id,
            Project.workspace_id == ctx.workspace_id,
        )
    )
    if not project:
        raise AppError(404, "NOT_FOUND", "项目不存在或无权访问")
    eff_role, _, _ = get_effective_project_permissions(db, ctx, project_id)
    if write and eff_role == "viewer":
        raise AppError(403, "READ_ONLY", "只读成员无权修改项目或提交任务")
    return project


def ensure_user_and_personal_workspace(db: Session, phone: str) -> tuple[User, Workspace, Member]:
    settings = get_settings()
    now = utcnow()
    p_lookup = sha256_hex(f"phone:{phone.strip()}")
    user = db.scalar(select(User).where(User.phone_lookup == p_lookup))
    suffix = phone.strip()[-4:] if len(phone.strip()) >= 4 else phone.strip()
    if not user:
        user = User(
            id=f"usr-{uuid.uuid4().hex[:12]}",
            phone_lookup=p_lookup,
            phone_ciphertext=f"enc:{phone.strip()}",
            display_name=f"灵猫创作者 {suffix}",
            created_at=now,
        )
        db.add(user)
        db.flush()

    workspace = db.scalar(
        select(Workspace).where(
            Workspace.owner_user_id == user.id,
            Workspace.kind == "personal",
        )
    )
    if not workspace:
        workspace = Workspace(
            id=f"ws-{uuid.uuid4().hex[:12]}",
            name=f"{user.display_name} 的个人空间",
            kind="personal",
            owner_user_id=user.id,
            event_cursor=0,
            permission_version=1,
            created_at=now,
        )
        db.add(workspace)
        db.flush()

        member = Member(
            workspace_id=workspace.id,
            user_id=user.id,
            role="owner",
            status="active",
            joined_at=now,
        )
        db.add(member)

        usage = WorkspaceUsageRecord(
            workspace_id=workspace.id,
            active_jobs=0,
            queued_jobs=0,
            used_bytes=0,
            pending_bytes=0,
            version=1,
        )
        db.add(usage)

        sub = SubscriptionRecord(
            id=f"sub-{uuid.uuid4().hex[:12]}",
            workspace_id=workspace.id,
            plan_id=None,
            provider_sub_id=None,
            offer_version="trial-v1",
            state="trialing",
            period_start=now,
            period_end=now + timedelta(days=30),
            cancel_at_period_end=False,
            updated_at=now,
        )
        db.add(sub)

        # Initial trial grant lot
        trial_credits = int(settings.initial_trial_credits)
        if trial_credits > 0:
            lot_id = f"lot-trial-{workspace.id}"
            lot = CreditLotRecord(
                id=lot_id,
                workspace_id=workspace.id,
                source="trial",
                grant_key="initial_trial_grant",
                original_credits=trial_credits,
                available=trial_credits,
                held=0,
                spent=0,
                expired=0,
                expires_at=now + timedelta(days=30),
                created_at=now,
            )
            db.add(lot)
            db.flush()

            ledger = CreditLedgerRecord(
                id=f"led-{uuid.uuid4().hex[:14]}",
                workspace_id=workspace.id,
                lot_id=lot.id,
                reservation_id=None,
                job_id=None,
                order_id=None,
                event_key="grant:initial_trial_grant",
                kind="grant",
                available_delta=trial_credits,
                held_delta=0,
                spent_delta=0,
                expired_delta=0,
                created_at=now,
            )
            db.add(ledger)
    else:
        member = db.get(Member, (workspace.id, user.id))
        if not member:
            member = Member(
                workspace_id=workspace.id,
                user_id=user.id,
                role="owner",
                status="active",
                joined_at=now,
            )
            db.add(member)

    db.flush()
    return user, workspace, member


def check_request_idempotency(
    db: Session,
    workspace_id: str,
    actor_id: str,
    operation: str,
    resource_scope: str,
    idempotency_key: str,
    body_digest: str,
) -> RequestKeyRecord | None:
    if not idempotency_key or not idempotency_key.strip():
        raise AppError(422, "INVALID_INPUT", "缺少有效的 Idempotency-Key 请求头")
    rec = db.get(
        RequestKeyRecord,
        (workspace_id, actor_id, operation, resource_scope, idempotency_key.strip()),
    )
    if rec is not None:
        if rec.body_digest != body_digest:
            raise AppError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "相同 Idempotency-Key 的请求参数摘要不一致",
                details={"idempotencyKey": idempotency_key, "operation": operation},
            )
        return rec
    return None


def save_request_idempotency(
    db: Session,
    workspace_id: str,
    actor_id: str,
    operation: str,
    resource_scope: str,
    idempotency_key: str,
    body_digest: str,
    resource_id: str,
    response_code: int,
) -> RequestKeyRecord:
    rec = RequestKeyRecord(
        workspace_id=workspace_id,
        actor_id=actor_id,
        operation=operation,
        resource_scope=resource_scope,
        key=idempotency_key.strip(),
        body_digest=body_digest,
        resource_id=resource_id,
        response_code=response_code,
        accepted_at=utcnow(),
    )
    db.add(rec)
    return rec
