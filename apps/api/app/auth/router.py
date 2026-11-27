from __future__ import annotations

import secrets
import uuid
from datetime import timedelta
from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.auth.deps import (
    SESSION_COOKIE_NAME,
    AuthContext,
    canonical_digest,
    check_request_idempotency,
    ensure_user_and_personal_workspace,
    get_current_context,
    require_project_access,
    save_request_idempotency,
    sha256_hex,
)
from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import (
    AuthChallenge,
    Member,
    ProjectGrantRecord,
    SubscriptionRecord,
    User,
    UserSession,
    Workspace,
    WorkspaceInvitation,
    WorkspaceUsageRecord,
    utcnow,
)
from app.providers.sms import send_otp_code
from app.schemas import (
    FeaturesFlags,
    Grant,
    InviteAccept,
    InviteCreate,
    InviteOut,
    Login,
    MemberOut,
    OtpChallenge,
    OtpSent,
    ProjectGrant,
    SessionOut,
    WorkspaceCreate,
    WorkspaceOut,
    WorkspaceSwitch,
    iso_utc,
)

router = APIRouter()


def _require_org_collaboration() -> None:
    settings = get_settings()
    if not settings.feature_org_collaboration:
        raise AppError(404, "FEATURE_DISABLED", "团队协作功能 (org_collaboration) 在当前版本未启用")


def _build_session_out(ctx: AuthContext) -> SessionOut:
    settings = get_settings()
    mode = "sandbox" if settings.env_mode == "sandbox" else "live"
    return SessionOut(
        userId=ctx.user_id,
        displayName=ctx.user.display_name,
        workspaceId=ctx.workspace_id,
        role=ctx.role,  # type: ignore[arg-type]
        mode=mode,
        features=FeaturesFlags(**settings.features_dict),
    )


def _should_use_secure_cookie(request: Request) -> bool:
    settings = get_settings()
    if settings.cookie_secure is not None:
        return bool(settings.cookie_secure)
    scheme = request.url.scheme.lower()
    if settings.trust_proxy_headers:
        fwd_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        if fwd_proto:
            scheme = fwd_proto
    return scheme == "https"


@router.post("/auth/otp", response_model=OtpSent, status_code=202)
def request_otp(body: OtpChallenge, db: Session = Depends(get_db)) -> OtpSent:
    phone = body.phone.strip()
    code = send_otp_code(phone)
    now = utcnow()
    expires_at = now + timedelta(minutes=5)
    p_lookup = sha256_hex(f"phone:{phone}")
    challenge = AuthChallenge(
        id=f"chl-{uuid.uuid4().hex[:14]}",
        phone_lookup=p_lookup,
        code_digest=f"{phone}|{sha256_hex(code)}",
        attempts=0,
        expires_at=expires_at,
        used_at=None,
        created_at=now,
    )
    db.add(challenge)
    db.commit()
    return OtpSent(
        challengeId=challenge.id,
        expiresAt=iso_utc(expires_at) or "",
        retryAfterSeconds=60,
    )


@router.post("/auth/session", response_model=SessionOut, status_code=200)
def start_session(
    body: Login,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> SessionOut:
    now = utcnow()
    challenge = db.scalar(
        select(AuthChallenge)
        .where(AuthChallenge.id == body.challengeId)
        .with_for_update()
    )
    if not challenge:
        raise AppError(401, "UNAUTHENTICATED", "验证码挑战不存在")
    if challenge.used_at is not None or challenge.expires_at <= now:
        raise AppError(410, "CHALLENGE_EXPIRED", "验证码已过期或已被使用")
    if challenge.attempts >= 5:
        raise AppError(429, "RATE_LIMIT", "验证码尝试次数过多，请重新获取")

    phone, expected_digest = challenge.code_digest.split("|", 1)
    if sha256_hex(body.code.strip()) != expected_digest:
        challenge.attempts += 1
        db.commit()
        raise AppError(401, "UNAUTHENTICATED", "短信验证码错误")

    challenge.used_at = now
    user, workspace, member = ensure_user_and_personal_workspace(db, phone)

    raw_token = f"lms_{secrets.token_urlsafe(32)}"
    token_digest = sha256_hex(raw_token)
    sess = UserSession(
        token_digest=token_digest,
        user_id=user.id,
        workspace_id=workspace.id,
        expires_at=now + timedelta(days=7),
        revoked_at=None,
        created_at=now,
    )
    db.add(sess)
    db.commit()

    secure_cookie = _should_use_secure_cookie(request)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_token,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        path="/",
        max_age=7 * 24 * 3600,
    )
    ctx = AuthContext(user=user, workspace=workspace, member=member, session=sess)
    return _build_session_out(ctx)


@router.get("/auth/session", response_model=SessionOut, status_code=200)
def get_session(ctx: AuthContext = Depends(get_current_context)) -> SessionOut:
    return _build_session_out(ctx)


@router.delete("/auth/session", status_code=204)
def end_session(
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> Response:
    ctx.session.revoked_at = utcnow()
    db.commit()
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        secure=_should_use_secure_cookie(request),
        httponly=True,
        samesite="lax",
    )
    return Response(status_code=204)


@router.get("/workspaces", response_model=list[WorkspaceOut])
def get_workspaces(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[WorkspaceOut]:
    settings = get_settings()
    rows = db.execute(
        select(Workspace, Member)
        .join(Member, Member.workspace_id == Workspace.id)
        .where(Member.user_id == ctx.user_id, Member.status == "active")
        .order_by(Workspace.created_at.asc())
    ).all()
    result: list[WorkspaceOut] = []
    for ws, mem in rows:
        if ws.kind == "team" and not settings.feature_org_collaboration:
            continue
        cnt = db.scalar(
            select(func.count())
            .select_from(Member)
            .where(Member.workspace_id == ws.id, Member.status == "active")
        ) or 1
        result.append(
            WorkspaceOut(
                id=ws.id,
                name=ws.name,
                kind=ws.kind,  # type: ignore[arg-type]
                role=mem.role,  # type: ignore[arg-type]
                members=int(cnt),
            )
        )
    return result


@router.post("/workspaces", response_model=WorkspaceOut, status_code=201)
def create_team(
    body: WorkspaceCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    _require_org_collaboration()
    now = utcnow()
    ws = Workspace(
        id=f"ws-team-{uuid.uuid4().hex[:10]}",
        name=body.name.strip(),
        kind="team",
        owner_user_id=ctx.user_id,
        event_cursor=0,
        permission_version=1,
        created_at=now,
    )
    db.add(ws)
    db.flush()
    mem = Member(
        workspace_id=ws.id,
        user_id=ctx.user_id,
        role="owner",
        status="active",
        joined_at=now,
    )
    db.add(mem)
    db.add(WorkspaceUsageRecord(workspace_id=ws.id))
    db.add(
        SubscriptionRecord(
            id=f"sub-{uuid.uuid4().hex[:12]}",
            workspace_id=ws.id,
            plan_id=None,
            provider_sub_id=None,
            offer_version="team-v1",
            state="none",
            updated_at=now,
        )
    )
    db.commit()
    return WorkspaceOut(id=ws.id, name=ws.name, kind="team", role="owner", members=1)


@router.put("/auth/workspace", response_model=SessionOut)
def switch_workspace(
    body: WorkspaceSwitch,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> SessionOut:
    _require_org_collaboration()
    ws = db.get(Workspace, body.workspaceId)
    mem = db.get(Member, (body.workspaceId, ctx.user_id))
    if not ws or not mem or mem.status != "active":
        raise AppError(404, "NOT_FOUND", "目标工作空间不存在或无访问权")
    ctx.session.workspace_id = ws.id
    db.commit()
    new_ctx = AuthContext(user=ctx.user, workspace=ws, member=mem, session=ctx.session)
    return _build_session_out(new_ctx)


@router.get("/workspaces/{workspaceId}/members", response_model=list[MemberOut])
def list_members(
    workspaceId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[MemberOut]:
    _require_org_collaboration()
    if workspaceId != ctx.workspace_id:
        raise AppError(404, "NOT_FOUND", "工作空间不存在")
    rows = db.execute(
        select(Member, User)
        .join(User, User.id == Member.user_id)
        .where(Member.workspace_id == workspaceId, Member.status == "active")
    ).all()
    return [
        MemberOut(userId=u.id, displayName=u.display_name, role=m.role)  # type: ignore[arg-type]
        for m, u in rows
    ]


@router.post("/workspaces/{workspaceId}/invitations", response_model=InviteOut, status_code=201)
def invite_member(
    workspaceId: str,
    body: InviteCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> InviteOut:
    _require_org_collaboration()
    if workspaceId != ctx.workspace_id or ctx.role != "owner":
        raise AppError(403, "FORBIDDEN", "仅空间管理员可发起成员邀请")
    raw_token = f"inv_{secrets.token_urlsafe(24)}"
    expires_at = utcnow() + timedelta(days=3)
    inv = WorkspaceInvitation(
        id=f"inv-{uuid.uuid4().hex[:12]}",
        workspace_id=workspaceId,
        token_digest=sha256_hex(raw_token),
        role=body.role,
        expires_at=expires_at,
    )
    db.add(inv)
    db.commit()
    return InviteOut(
        id=inv.id,
        workspaceId=workspaceId,
        role=body.role,
        expiresAt=iso_utc(expires_at) or "",
        inviteUrl=f"/invitations/accept?token={raw_token}",
    )


@router.post("/invitations/accept", response_model=WorkspaceOut)
def accept_invitation(
    body: InviteAccept,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    _require_org_collaboration()
    digest = canonical_digest(body.model_dump())
    existing_key = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "acceptInvitation", "invitations", idempotency_key, digest
    )
    if existing_key:
        ws = db.get(Workspace, existing_key.resource_id)
        mem = db.get(Member, (existing_key.resource_id, ctx.user_id))
        if ws and mem:
            cnt = db.scalar(
                select(func.count()).select_from(Member).where(Member.workspace_id == ws.id, Member.status == "active")
            ) or 1
            return WorkspaceOut(id=ws.id, name=ws.name, kind=ws.kind, role=mem.role, members=int(cnt))  # type: ignore[arg-type]

    inv = db.scalar(
        select(WorkspaceInvitation)
        .where(WorkspaceInvitation.token_digest == sha256_hex(body.token.strip()))
        .with_for_update()
    )
    if not inv:
        raise AppError(404, "NOT_FOUND", "邀请链接不存在")
    if inv.used_at is not None or inv.expires_at <= utcnow():
        raise AppError(410, "INVITATION_EXPIRED", "邀请链接已失效或已被使用")

    inv.used_by = ctx.user_id
    inv.used_at = utcnow()
    mem = db.get(Member, (inv.workspace_id, ctx.user_id))
    if not mem:
        mem = Member(
            workspace_id=inv.workspace_id,
            user_id=ctx.user_id,
            role=inv.role,
            status="active",
            joined_at=utcnow(),
        )
        db.add(mem)
    else:
        mem.status = "active"
        mem.role = inv.role

    ws = db.get(Workspace, inv.workspace_id)
    assert ws is not None
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "acceptInvitation", "invitations", idempotency_key, digest, ws.id, 200
    )
    db.commit()
    cnt = db.scalar(
        select(func.count()).select_from(Member).where(Member.workspace_id == ws.id, Member.status == "active")
    ) or 1
    return WorkspaceOut(id=ws.id, name=ws.name, kind=ws.kind, role=mem.role, members=int(cnt))  # type: ignore[arg-type]


@router.patch("/workspaces/{workspaceId}/members/{userId}", response_model=MemberOut)
def change_member_role(
    workspaceId: str,
    userId: str,
    body: Grant,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> MemberOut:
    _require_org_collaboration()
    if workspaceId != ctx.workspace_id or ctx.role != "owner":
        raise AppError(403, "FORBIDDEN", "无权修改成员角色")
    mem = db.get(Member, (workspaceId, userId))
    user = db.get(User, userId)
    if not mem or not user or mem.status != "active":
        raise AppError(404, "NOT_FOUND", "成员不存在")
    mem.role = body.role
    ctx.workspace.permission_version += 1
    db.commit()
    return MemberOut(userId=user.id, displayName=user.display_name, role=mem.role)  # type: ignore[arg-type]


@router.delete("/workspaces/{workspaceId}/members/{userId}", status_code=204)
def revoke_member(
    workspaceId: str,
    userId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> Response:
    _require_org_collaboration()
    if workspaceId != ctx.workspace_id or ctx.role != "owner":
        raise AppError(403, "FORBIDDEN", "无权移除成员")
    mem = db.get(Member, (workspaceId, userId))
    if not mem or mem.status != "active":
        raise AppError(404, "NOT_FOUND", "成员不存在")
    if mem.role == "owner":
        owner_cnt = db.scalar(
            select(func.count())
            .select_from(Member)
            .where(Member.workspace_id == workspaceId, Member.role == "owner", Member.status == "active")
        ) or 0
        if owner_cnt <= 1:
            raise AppError(409, "LAST_OWNER", "不能移除工作空间的最后一位管理员")
    mem.status = "revoked"
    ctx.workspace.permission_version += 1
    db.commit()
    return Response(status_code=204)


@router.put("/projects/{projectId}/members/{userId}", response_model=ProjectGrant)
def set_project_grant(
    projectId: str,
    userId: str,
    body: ProjectGrant,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> ProjectGrant:
    _require_org_collaboration()
    require_project_access(db, ctx, projectId, write=True)
    grant = db.get(ProjectGrantRecord, (projectId, userId))
    if not grant:
        grant = ProjectGrantRecord(
            project_id=projectId,
            user_id=userId,
            workspace_id=ctx.workspace_id,
            role=body.role,
            allow_copy=body.allowCopy,
            allow_download=body.allowDownload,
            updated_at=utcnow(),
        )
        db.add(grant)
    else:
        grant.role = body.role
        grant.allow_copy = body.allowCopy
        grant.allow_download = body.allowDownload
        grant.updated_at = utcnow()
    ctx.workspace.permission_version += 1
    db.commit()
    return body
