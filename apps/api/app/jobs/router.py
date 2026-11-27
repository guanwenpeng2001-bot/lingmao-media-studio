from __future__ import annotations

import asyncio
import copy
import io
import json
import tempfile
import uuid
import zipfile
from datetime import timedelta
from typing import Any
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.assets.router import resolve_asset_delivery_variant
from app.auth.deps import (
    AuthContext,
    canonical_digest,
    check_request_idempotency,
    get_current_context,
    get_effective_project_permissions,
    require_project_access,
    save_request_idempotency,
    sha256_hex,
)
from app.billing.ledger import (
    build_billing_state,
    lock_workspace_usage,
    reserve_credits_for_items,
)
from app.config import get_settings
from app.db import get_db, get_session_factory
from app.errors import AppError
from app.jobs.settlement import (
    append_job_event,
    build_job_out,
    settle_job_succeeded,
    settle_job_terminal_failure_or_cancel,
    transition_job_to_running,
)
from app.models import (
    AssetRecord,
    CanvasRecord,
    JobEventRecord,
    JobRecord,
    ModelCatalogRecord,
    PlatformPresetRecord,
    PortraitCatalogRecord,
    PortraitConsentRecord,
    ProviderDispatchRecord,
    ProviderInboxRecord,
    QuoteItemRecord,
    QuoteRecord,
    ReservationRecord,
    RunRecord,
    RunStepRecord,
    SubjectRecord,
    SubjectVersionRecord,
    utcnow,
)
from app.providers.generation import (
    DeterministicDemoGenerationAdapter,
    validate_generation_webhook_secret,
    verify_webhook_signature,
)
from app.providers.storage import PrivateObjectStorage
from app.schemas import (
    BatchOut,
    BatchQuoteInput,
    BatchQuoteItemOut,
    BatchQuoteOut,
    CancelJob,
    GenerationInput,
    Graph,
    JobCreate,
    JobEventOut,
    JobOut,
    JobPage,
    Parameters,
    PriceBreakdownItem,
    QuoteOut,
    RunOut,
    RunQuoteInput,
    RunQuoteOut,
    RunQuoteStepOut,
    RunStepOut,
    iso_utc,
)

router = APIRouter()

BLOCKED_KEYWORDS = ("__block_content__", "违禁测试词", "__nsfw_block__")


def _check_content_safety(prompt: str) -> None:
    lower = prompt.lower()
    for kw in BLOCKED_KEYWORDS:
        if kw in lower:
            raise AppError(422, "CONTENT_BLOCKED", "提示词未通过内容安全审核，未冻结任何积分")


def _ensure_provider_ready() -> str:
    settings = get_settings()
    if settings.is_demo_inference:
        return "demo-deterministic"
    if settings.has_live_inference:
        return "live-provider"
    raise AppError(
        503,
        "PROVIDER_UNAVAILABLE",
        "当前环境未配置真实模型推理服务，且未显式开启开发联调确定性推理适配器",
    )


def _calculate_item_cost(mode: str, model: ModelCatalogRecord, params: Parameters) -> int:
    if mode in ("image_to_video", "text_to_video"):
        dur = int(params.durationSeconds or 5)
        return dur * 8
    if mode == "video_compose":
        return 20
    if mode == "product_scene":
        return 15
    if mode in ("subject_cutout", "remove_background"):
        return 5
    if mode in ("try_on", "hand_held", "worn"):
        return 20
    return int(model.base_credits or 10)


def _validate_and_freeze_input(
    db: Session,
    ctx: AuthContext,
    project_id: str,
    gen_input: GenerationInput,
) -> tuple[ModelCatalogRecord, int, dict[str, Any]]:
    settings = get_settings()
    if gen_input.mode in ("try_on", "hand_held", "worn") and not settings.feature_virtual_tryon:
        raise AppError(404, "FEATURE_DISABLED", f"模式 {gen_input.mode} 依赖的 virtual_tryon 开关未启用")

    _check_content_safety(gen_input.prompt)
    _ensure_provider_ready()

    model = db.scalar(
        select(ModelCatalogRecord)
        .where(ModelCatalogRecord.id == gen_input.modelId, ModelCatalogRecord.active.is_(True))
        .order_by(ModelCatalogRecord.version.desc())
    )
    if not model:
        raise AppError(422, "INVALID_INPUT", f"模型 {gen_input.modelId} 不存在或未启用")

    if gen_input.mode not in (model.modes or []):
        raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持模式 {gen_input.mode}")

    params = gen_input.parameters
    if params.aspectRatio not in (model.aspect_ratios or []):
        raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持画幅比例 {params.aspectRatio}")

    if gen_input.mode in ("image_to_video", "text_to_video"):
        if params.durationSeconds not in (model.duration_seconds or []):
            raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持视频时长 {params.durationSeconds}s")

    if params.resolution and params.resolution not in (model.resolutions or []):
        raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持分辨率 {params.resolution}")

    if params.nativeAudio and not model.native_audio:
        raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持原生音轨生成")

    billing_state = build_billing_state(db, ctx.workspace_id)
    if model.id not in billing_state.entitlements.allowedModelIds:
        raise AppError(403, "ENTITLEMENT_REQUIRED", f"当前套餐无权使用模型 {model.id}")

    if gen_input.canvasId:
        canvas = db.scalar(
            select(CanvasRecord).where(
                CanvasRecord.id == gen_input.canvasId,
                CanvasRecord.workspace_id == ctx.workspace_id,
                CanvasRecord.project_id == project_id,
            )
        )
        if not canvas:
            raise AppError(404, "NOT_FOUND", f"画布 {gen_input.canvasId} 不存在或不属于该项目")

    # Verify input assets belong to (workspace_id, project_id) and are ready
    frozen_assets: dict[str, str] = {}
    first_asset: AssetRecord | None = None
    for idx, aid in enumerate(gen_input.inputAssetIds):
        asset = db.scalar(
            select(AssetRecord).where(
                AssetRecord.id == aid,
                AssetRecord.workspace_id == ctx.workspace_id,
                AssetRecord.project_id == project_id,
                AssetRecord.state == "ready",
            )
        )
        if not asset:
            raise AppError(
                404,
                "NOT_FOUND",
                f"输入素材 {aid} 不存在、已归档或不属于当前项目空间",
                details={"assetId": aid},
            )
        if gen_input.mode == "video_compose":
            if asset.media_kind != "video":
                raise AppError(422, "INVALID_INPUT", f"视频合成输入素材 {aid} 必须为视频")
        else:
            if asset.media_kind != "image":
                raise AppError(422, "INVALID_INPUT", f"输入素材 {aid} 必须为图片")
        if idx == 0:
            first_asset = asset
        frozen_assets[aid] = asset.sha256

    resolved_mask_id = params.maskAssetId
    if params.maskAssetId:
        mask_asset = db.scalar(
            select(AssetRecord).where(
                AssetRecord.id == params.maskAssetId,
                AssetRecord.workspace_id == ctx.workspace_id,
                AssetRecord.project_id == project_id,
                AssetRecord.state == "ready",
            )
        )
        if not mask_asset or mask_asset.media_kind != "image":
            raise AppError(404, "NOT_FOUND", f"蒙版素材 {params.maskAssetId} 不存在或不可用")
        frozen_assets[mask_asset.id] = mask_asset.sha256

    frozen_subject_ver: int | None = None
    if params.subjectId:
        subj = db.scalar(
            select(SubjectRecord).where(
                SubjectRecord.id == params.subjectId,
                SubjectRecord.workspace_id == ctx.workspace_id,
                SubjectRecord.project_id == project_id,
            )
        )
        if not subj:
            raise AppError(404, "NOT_FOUND", f"商品主体 {params.subjectId} 不存在或无权访问")
        sver = db.get(SubjectVersionRecord, (subj.id, subj.current_version))
        if not sver:
            raise AppError(404, "NOT_FOUND", "商品主体版本记录缺失")
        frozen_subject_ver = int(sver.version)
        if not resolved_mask_id and sver.mask_asset_id:
            resolved_mask_id = sver.mask_asset_id

    if params.lastFrameAssetId:
        if not model.supports_last_frame:
            raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持尾帧控制")
        last_asset = db.scalar(
            select(AssetRecord).where(
                AssetRecord.id == params.lastFrameAssetId,
                AssetRecord.workspace_id == ctx.workspace_id,
                AssetRecord.project_id == project_id,
                AssetRecord.state == "ready",
            )
        )
        if not last_asset or last_asset.media_kind != "image":
            raise AppError(404, "NOT_FOUND", f"尾帧素材 {params.lastFrameAssetId} 不存在或不可用")
        if (
            first_asset
            and first_asset.width
            and first_asset.height
            and last_asset.width
            and last_asset.height
        ):
            r1 = round(first_asset.width / first_asset.height, 2)
            r2 = round(last_asset.width / last_asset.height, 2)
            if abs(r1 - r2) > 0.05 and not params.endFrameCrop:
                raise AppError(
                    422,
                    "INVALID_INPUT",
                    "首尾帧图片画幅比例不一致，请裁切或指定 parameters.endFrameCrop",
                    details={"firstFrameRatio": r1, "lastFrameRatio": r2},
                )
        frozen_assets[last_asset.id] = last_asset.sha256

    if params.platformPresetId:
        preset = db.scalar(
            select(PlatformPresetRecord)
            .where(PlatformPresetRecord.id == params.platformPresetId)
            .order_by(PlatformPresetRecord.version.desc())
        )
        if not preset:
            raise AppError(422, "INVALID_INPUT", f"平台规格预设 {params.platformPresetId} 不存在")

    if params.portrait:
        if params.portrait.catalogId:
            pcat = db.scalar(
                select(PortraitCatalogRecord).where(PortraitCatalogRecord.id == params.portrait.catalogId)
            )
            if not pcat:
                raise AppError(404, "NOT_FOUND", f"模特形象 {params.portrait.catalogId} 不存在")
        elif params.portrait.assetId and params.portrait.consentId:
            consent = db.scalar(
                select(PortraitConsentRecord).where(
                    PortraitConsentRecord.id == params.portrait.consentId,
                    PortraitConsentRecord.workspace_id == ctx.workspace_id,
                    PortraitConsentRecord.project_id == project_id,
                    PortraitConsentRecord.asset_id == params.portrait.assetId,
                    PortraitConsentRecord.revoked_at.is_(None),
                )
            )
            if not consent:
                raise AppError(422, "INVALID_INPUT", "私人模特素材缺少有效肖像使用授权记录")

    cost = _calculate_item_cost(gen_input.mode, model, params)
    frozen_payload = gen_input.model_dump(exclude_none=True)
    frozen_payload["_frozenMeta"] = {
        "modelVersion": int(model.version),
        "pricingVersion": model.pricing_version,
        "assetDigests": frozen_assets,
        "subjectVersion": frozen_subject_ver,
        "resolvedMaskAssetId": resolved_mask_id,
    }
    return model, cost, frozen_payload


@router.post("/projects/{projectId}/quotes", response_model=QuoteOut, status_code=201)
def quote_generation(
    projectId: str,
    body: GenerationInput,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> QuoteOut:
    require_project_access(db, ctx, projectId, write=True)
    model, cost, frozen_payload = _validate_and_freeze_input(db, ctx, projectId, body)
    settings = get_settings()
    now = utcnow()
    expires_at = now + timedelta(seconds=int(settings.quote_ttl_seconds))

    quote_id = f"quote-{uuid.uuid4().hex[:14]}"
    quote = QuoteRecord(
        id=quote_id,
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        canvas_id=body.canvasId,
        created_by=ctx.user_id,
        kind="single",
        pricing_version=model.pricing_version,
        frozen_request=frozen_payload,
        canvas_revision=None,
        total_credits=cost,
        expires_at=expires_at,
        consumed_at=None,
        created_at=now,
    )
    db.add(quote)
    db.flush()

    q_item = QuoteItemRecord(
        id=f"qi-{uuid.uuid4().hex[:14]}",
        quote_id=quote.id,
        ordinal=0,
        node_id=body.nodeId,
        aspect_ratio=body.parameters.aspectRatio,
        input_bindings=frozen_payload,
        cost=cost,
    )
    db.add(q_item)
    db.commit()

    return QuoteOut(
        id=quote.id,
        projectId=projectId,
        credits=cost,
        pricingVersion=model.pricing_version,
        expiresAt=iso_utc(expires_at) or "",
        mode=body.mode,
        modelId=body.modelId,
        priceBreakdown=[PriceBreakdownItem(reason=f"{body.mode} ({body.modelId})", credits=cost)],
    )


def _submit_single_job_tx(
    db: Session,
    ctx: AuthContext,
    project_id: str,
    quote_id: str,
    idempotency_key: str,
    operation: str,
    resource_scope: str,
    retry_of_job_id: str | None = None,
) -> JobOut:
    provider_name = _ensure_provider_ready()
    settings = get_settings()
    usage = lock_workspace_usage(db, ctx.workspace_id)

    digest = canonical_digest({"quoteId": quote_id, "retryOfJobId": retry_of_job_id})
    existing_key = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, operation, resource_scope, idempotency_key, digest
    )
    if existing_key:
        existing_job = db.get(JobRecord, existing_key.resource_id)
        if existing_job:
            return build_job_out(db, existing_job)

    quote = db.scalar(
        select(QuoteRecord)
        .where(
            QuoteRecord.id == quote_id,
            QuoteRecord.workspace_id == ctx.workspace_id,
            QuoteRecord.project_id == project_id,
            QuoteRecord.kind == "single",
        )
        .with_for_update()
    )
    if not quote:
        raise AppError(404, "NOT_FOUND", f"报价单 {quote_id} 不存在或不属于当前项目")

    q_item = db.scalar(
        select(QuoteItemRecord)
        .where(QuoteItemRecord.quote_id == quote.id, QuoteItemRecord.ordinal == 0)
        .with_for_update()
    )
    assert q_item is not None

    if quote.consumed_at is not None:
        orig_job = db.scalar(select(JobRecord).where(JobRecord.quote_item_id == q_item.id))
        raise AppError(
            409,
            "QUOTE_USED",
            f"报价单 {quote.id} 已被消费，不可使用不同幂等键重复提交",
            details={"existingJobId": orig_job.id if orig_job else quote.id, "quoteId": quote.id},
        )

    now = utcnow()
    if quote.expires_at <= now:
        raise AppError(
            410,
            "QUOTE_EXPIRED",
            f"报价单 {quote.id} 已过期，请重新获取报价",
            details={"quoteId": quote.id, "expiresAt": iso_utc(quote.expires_at)},
        )

    if int(usage.queued_jobs) >= settings.default_queue_limit:
        raise AppError(
            429,
            "QUEUE_LIMIT",
            "当前工作空间排队任务数已达上限，请稍后重试",
            details={"queuedJobs": int(usage.queued_jobs), "limit": settings.default_queue_limit},
        )

    # Re-verify input assets are still present and ready
    frozen_req = copy.deepcopy(quote.frozen_request)
    for aid in frozen_req.get("inputAssetIds") or []:
        asset = db.scalar(
            select(AssetRecord).where(
                AssetRecord.id == aid,
                AssetRecord.workspace_id == ctx.workspace_id,
                AssetRecord.project_id == project_id,
                AssetRecord.state == "ready",
            )
        )
        if not asset:
            raise AppError(404, "NOT_FOUND", f"报价绑定的输入素材 {aid} 已不可用")

    job_id = f"job-{uuid.uuid4().hex[:14]}"
    job = JobRecord(
        id=job_id,
        workspace_id=ctx.workspace_id,
        project_id=project_id,
        quote_item_id=q_item.id,
        run_id=None,
        batch_id=None,
        canvas_id=quote.canvas_id,
        node_id=q_item.node_id,
        retry_of_job_id=retry_of_job_id,
        state="queued",
        revision=1,
        frozen_input=frozen_req,
        result_refs=[],
        progress=0,
        cancel_requested=False,
        error_code=None,
        priority=0,
        not_before=now,
        created_at=now,
        updated_at=now,
        deadline_at=now + timedelta(minutes=15),
    )
    db.add(job)
    db.flush()

    # Hold credits across earliest-expiring lots
    reserve_credits_for_items(db, ctx.workspace_id, [(q_item.id, int(q_item.cost), job.id)])
    quote.consumed_at = now

    disp = ProviderDispatchRecord(
        id=f"dsp-{uuid.uuid4().hex[:14]}",
        workspace_id=ctx.workspace_id,
        job_id=job.id,
        provider=provider_name,
        dispatch_key=f"disp:{job.id}:1",
        provider_job_id=None,
        attempt=1,
        lease_owner=None,
        lease_until=None,
        lease_epoch=0,
        state="queued",
        next_poll_at=now,
        last_error=None,
    )
    db.add(disp)

    usage.queued_jobs += 1
    usage.version += 1
    append_job_event(db, ctx.workspace_id, job)
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, operation, resource_scope, idempotency_key, digest, job.id, 202
    )
    db.commit()
    return build_job_out(db, job)


@router.post("/projects/{projectId}/jobs", response_model=JobOut, status_code=202)
def submit_job(
    projectId: str,
    body: JobCreate,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> JobOut:
    require_project_access(db, ctx, projectId, write=True)
    return _submit_single_job_tx(
        db=db,
        ctx=ctx,
        project_id=projectId,
        quote_id=body.quoteId,
        idempotency_key=idempotency_key,
        operation="submitJob",
        resource_scope=projectId,
        retry_of_job_id=None,
    )


@router.get("/jobs", response_model=JobPage)
def list_jobs(
    project_id: str | None = Query(default=None, alias="projectId"),
    status: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> JobPage:
    stmt = select(JobRecord).where(JobRecord.workspace_id == ctx.workspace_id)
    if project_id:
        stmt = stmt.where(JobRecord.project_id == project_id)
    if status:
        stmt = stmt.where(JobRecord.state == status)
    stmt = stmt.order_by(JobRecord.created_at.desc(), JobRecord.id.desc())
    rows = list(db.scalars(stmt).all())

    start_idx = 0
    if cursor:
        for idx, r in enumerate(rows):
            if r.id == cursor:
                start_idx = idx + 1
                break
    page = rows[start_idx : start_idx + limit]
    next_cursor = page[-1].id if len(rows) > start_idx + limit and page else None
    return JobPage(items=[build_job_out(db, j) for j in page], nextCursor=next_cursor)


@router.get("/jobs/{jobId}", response_model=JobOut)
def get_job(
    jobId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> JobOut:
    job = db.scalar(
        select(JobRecord).where(
            JobRecord.id == jobId,
            JobRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not job:
        raise AppError(404, "NOT_FOUND", "任务不存在或无权访问")
    return build_job_out(db, job)


@router.post("/jobs/{jobId}/cancel", response_model=JobOut)
def cancel_job(
    jobId: str,
    body: CancelJob,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> JobOut:
    lock_workspace_usage(db, ctx.workspace_id)
    digest = canonical_digest(body.model_dump())
    existing_key = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "cancelJob", jobId, idempotency_key, digest
    )
    job = db.scalar(
        select(JobRecord)
        .where(JobRecord.id == jobId, JobRecord.workspace_id == ctx.workspace_id)
        .with_for_update()
    )
    if not job:
        raise AppError(404, "NOT_FOUND", "任务不存在或无权访问")
    require_project_access(db, ctx, job.project_id, write=True)

    if existing_key:
        return build_job_out(db, job)

    if job.state in ("succeeded", "failed", "cancelled"):
        raise AppError(409, "JOB_TERMINAL", f"任务已处于终态 {job.state}，无法取消")

    if job.state == "running" and not body.confirmRunning:
        raise AppError(
            409,
            "CONFIRM_RUNNING_CANCEL",
            "任务已在执行中，取消需传入 confirmRunning=true 二次确认",
            details={"jobId": job.id, "status": job.state},
        )

    job.cancel_requested = True
    settle_job_terminal_failure_or_cancel(db, job.id, target_state="cancelled", error_code=None)
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "cancelJob", jobId, idempotency_key, digest, job.id, 200
    )
    db.commit()
    return build_job_out(db, job)


@router.post("/jobs/{jobId}/retry", response_model=JobOut, status_code=202)
def retry_job(
    jobId: str,
    body: JobCreate,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> JobOut:
    orig_job = db.scalar(
        select(JobRecord).where(
            JobRecord.id == jobId,
            JobRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not orig_job:
        raise AppError(404, "NOT_FOUND", "原任务不存在或无权访问")
    require_project_access(db, ctx, orig_job.project_id, write=True)
    if orig_job.state not in ("failed", "cancelled"):
        raise AppError(409, "JOB_NOT_RETRYABLE", f"仅失败或已取消任务可重试，当前状态为 {orig_job.state}")

    return _submit_single_job_tx(
        db=db,
        ctx=ctx,
        project_id=orig_job.project_id,
        quote_id=body.quoteId,
        idempotency_key=idempotency_key,
        operation="retryJob",
        resource_scope=jobId,
        retry_of_job_id=orig_job.id,
    )


@router.get("/events/jobs")
async def watch_jobs(
    request: Request,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    last_event_id_query: str | None = Query(default=None, alias="lastEventId"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    workspace_id = ctx.workspace_id
    has_header = "last-event-id" in request.headers
    if has_header:
        raw_cursor: str | None = (
            last_event_id if last_event_id is not None else request.headers.get("last-event-id")
        )
    elif "lastEventId" in request.query_params:
        raw_cursor = (
            last_event_id_query
            if last_event_id_query is not None
            else request.query_params.get("lastEventId")
        )
    else:
        raw_cursor = None

    cursor_seq = 0
    if raw_cursor is not None:
        stripped = raw_cursor.strip()
        if not stripped or not stripped.isdigit():
            raise AppError(400, "INVALID_INPUT", f"无效的 Last-Event-ID 游标格式: {raw_cursor}")
        cursor_seq = int(stripped)

        min_seq = db.scalar(
            select(func.min(JobEventRecord.seq)).where(
                JobEventRecord.workspace_id == workspace_id
            )
        )
        if min_seq is not None and cursor_seq < int(min_seq) - 1:
            raise AppError(
                410,
                "CURSOR_EXPIRED",
                f"事件游标 {cursor_seq} 已超出当前空间保留窗口",
            )
        if cursor_seq > 0:
            cursor_evt = db.scalar(
                select(JobEventRecord).where(
                    JobEventRecord.workspace_id == workspace_id,
                    JobEventRecord.seq == cursor_seq,
                )
            )
            if cursor_evt is None or cursor_evt.at < utcnow() - timedelta(days=7):
                raise AppError(
                    410,
                    "CURSOR_EXPIRED",
                    f"事件游标 {cursor_seq} 已过期或不存在于当前工作空间",
                )

    session_factory = get_session_factory()

    async def _event_generator():
        nonlocal cursor_seq
        # Stream historical & live events up to a bounded window so HTTP clients and SSE subscribers receive events cleanly
        max_ticks = 6
        for tick in range(max_ticks):
            if await request.is_disconnected():
                break
            with session_factory() as sdb:
                evts = list(
                    sdb.scalars(
                        select(JobEventRecord)
                        .where(
                            JobEventRecord.workspace_id == workspace_id,
                            JobEventRecord.seq > cursor_seq,
                        )
                        .order_by(JobEventRecord.seq.asc())
                        .limit(100)
                    ).all()
                )
                active_cnt = len(
                    sdb.scalars(
                        select(JobRecord.id).where(
                            JobRecord.workspace_id == workspace_id,
                            JobRecord.state.in_(["queued", "running"]),
                        )
                    ).all()
                )
            for e in evts:
                cursor_seq = int(e.seq)
                payload = JobEventOut(
                    eventId=str(e.seq),
                    jobId=e.job_id,
                    revision=int(e.revision),
                    status=e.status,  # type: ignore[arg-type]
                    at=iso_utc(e.at) or "",
                ).model_dump()
                yield f"id: {e.seq}\nevent: job\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

            if active_cnt == 0 and tick >= 1:
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/projects/{projectId}/batch-quotes", response_model=BatchQuoteOut, status_code=201)
def quote_batch(
    projectId: str,
    body: BatchQuoteInput,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> BatchQuoteOut:
    require_project_access(db, ctx, projectId, write=True)
    model, _, base_frozen = _validate_and_freeze_input(db, ctx, projectId, body.input)

    total_qty = sum(v.quantity for v in body.variants)
    if total_qty > 24:
        raise AppError(422, "INVALID_INPUT", f"单批次生成总张数 {total_qty} 超过上限 24")

    settings = get_settings()
    now = utcnow()
    expires_at = now + timedelta(seconds=int(settings.quote_ttl_seconds))
    quote_id = f"bquote-{uuid.uuid4().hex[:14]}"

    items_to_create: list[QuoteItemRecord] = []
    items_out: list[BatchQuoteItemOut] = []
    ordinal = 0
    total_credits = 0

    for var in body.variants:
        if var.aspectRatio not in (model.aspect_ratios or []):
            raise AppError(422, "INVALID_INPUT", f"模型 {model.id} 不支持画幅 {var.aspectRatio}")
        preset: PlatformPresetRecord | None = None
        if var.presetId:
            preset = db.scalar(
                select(PlatformPresetRecord)
                .where(PlatformPresetRecord.id == var.presetId)
                .order_by(PlatformPresetRecord.version.desc())
            )
            if not preset:
                raise AppError(422, "INVALID_INPUT", f"平台预设 {var.presetId} 不存在")

        for _ in range(var.quantity):
            item_input = copy.deepcopy(base_frozen)
            params_dict = item_input.setdefault("parameters", {})
            params_dict["aspectRatio"] = var.aspectRatio
            if var.presetId and preset:
                params_dict["platformPresetId"] = preset.id
                params_dict["width"] = int(preset.width)
                params_dict["height"] = int(preset.height)
            if var.outputKind:
                params_dict["outputKind"] = var.outputKind
            if var.overlay:
                params_dict["overlay"] = var.overlay.model_dump(exclude_none=True)

            item_cost = _calculate_item_cost(body.input.mode, model, Parameters.model_validate(params_dict))
            item_id = f"qi-{uuid.uuid4().hex[:14]}"
            items_to_create.append(
                QuoteItemRecord(
                    id=item_id,
                    quote_id=quote_id,
                    ordinal=ordinal,
                    node_id=body.input.nodeId,
                    aspect_ratio=var.aspectRatio,
                    input_bindings=item_input,
                    cost=item_cost,
                )
            )
            items_out.append(
                BatchQuoteItemOut(
                    itemId=item_id,
                    aspectRatio=var.aspectRatio,
                    credits=item_cost,
                )
            )
            total_credits += item_cost
            ordinal += 1

    quote = QuoteRecord(
        id=quote_id,
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        canvas_id=body.input.canvasId,
        created_by=ctx.user_id,
        kind="batch",
        pricing_version=model.pricing_version,
        frozen_request=body.model_dump(exclude_none=True),
        canvas_revision=None,
        total_credits=total_credits,
        expires_at=expires_at,
        consumed_at=None,
        created_at=now,
    )
    db.add(quote)
    db.flush()
    for qi in items_to_create:
        db.add(qi)
    db.commit()

    return BatchQuoteOut(
        id=quote.id,
        items=items_out,
        totalCredits=total_credits,
        expiresAt=iso_utc(expires_at) or "",
    )


def _build_batch_out(db: Session, run: RunRecord) -> BatchOut:
    steps = list(
        db.scalars(
            select(RunStepRecord)
            .where(RunStepRecord.run_id == run.id)
            .order_by(RunStepRecord.id.asc())
        ).all()
    )
    job_ids = [s.job_id for s in steps if s.job_id]
    charged = 0
    for jid in job_ids:
        res = db.scalar(select(ReservationRecord).where(ReservationRecord.job_id == jid))
        if res and res.state == "captured":
            charged += int(res.actual)
    return BatchOut(
        id=run.id,
        projectId=run.project_id,
        status=run.status,  # type: ignore[arg-type]
        jobIds=job_ids,
        chargedCredits=charged,
    )


@router.post("/projects/{projectId}/batches", response_model=BatchOut, status_code=202)
def submit_batch(
    projectId: str,
    body: JobCreate,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> BatchOut:
    require_project_access(db, ctx, projectId, write=True)
    provider_name = _ensure_provider_ready()
    usage = lock_workspace_usage(db, ctx.workspace_id)

    digest = canonical_digest(body.model_dump())
    existing_key = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "submitBatch", projectId, idempotency_key, digest
    )
    if existing_key:
        existing_run = db.get(RunRecord, existing_key.resource_id)
        if existing_run:
            return _build_batch_out(db, existing_run)

    quote = db.scalar(
        select(QuoteRecord)
        .where(
            QuoteRecord.id == body.quoteId,
            QuoteRecord.workspace_id == ctx.workspace_id,
            QuoteRecord.project_id == projectId,
            QuoteRecord.kind == "batch",
        )
        .with_for_update()
    )
    if not quote:
        raise AppError(404, "NOT_FOUND", f"批量报价单 {body.quoteId} 不存在")

    if quote.consumed_at is not None:
        orig_run = db.scalar(select(RunRecord).where(RunRecord.quote_id == quote.id))
        raise AppError(
            409,
            "QUOTE_USED",
            f"批量报价单 {quote.id} 已被消费",
            details={"quoteId": quote.id, "batchId": orig_run.id if orig_run else None},
        )

    now = utcnow()
    if quote.expires_at <= now:
        raise AppError(410, "QUOTE_EXPIRED", f"批量报价单 {quote.id} 已过期")

    q_items = list(
        db.scalars(
            select(QuoteItemRecord)
            .where(QuoteItemRecord.quote_id == quote.id)
            .order_by(QuoteItemRecord.ordinal.asc())
            .with_for_update()
        ).all()
    )

    batch_id = f"bat-{uuid.uuid4().hex[:14]}"
    run = RunRecord(
        id=batch_id,
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        canvas_id=quote.canvas_id,
        base_revision=None,
        kind="batch",
        quote_id=quote.id,
        status="running",
        graph_snapshot=None,
        created_at=now,
        updated_at=now,
    )
    db.add(run)
    db.flush()

    reservation_specs: list[tuple[str, int, str | None]] = []
    created_jobs: list[JobRecord] = []
    for qi in q_items:
        job_id = f"job-{uuid.uuid4().hex[:14]}"
        job = JobRecord(
            id=job_id,
            workspace_id=ctx.workspace_id,
            project_id=projectId,
            quote_item_id=qi.id,
            run_id=run.id,
            batch_id=run.id,
            canvas_id=quote.canvas_id,
            node_id=qi.node_id,
            retry_of_job_id=None,
            state="queued",
            revision=1,
            frozen_input=qi.input_bindings,
            result_refs=[],
            progress=0,
            cancel_requested=False,
            error_code=None,
            priority=0,
            not_before=now,
            created_at=now,
            updated_at=now,
            deadline_at=now + timedelta(minutes=15),
        )
        db.add(job)
        created_jobs.append(job)
        reservation_specs.append((qi.id, int(qi.cost), job.id))

        step = RunStepRecord(
            id=f"stp-{uuid.uuid4().hex[:14]}",
            run_id=run.id,
            node_id=qi.node_id,
            quote_item_id=qi.id,
            state="queued",
            input_bindings=qi.input_bindings,
            depends_on=[],
            job_id=job.id,
        )
        db.add(step)

    db.flush()
    reserve_credits_for_items(db, ctx.workspace_id, reservation_specs)
    quote.consumed_at = now

    for job in created_jobs:
        db.add(
            ProviderDispatchRecord(
                id=f"dsp-{uuid.uuid4().hex[:14]}",
                workspace_id=ctx.workspace_id,
                job_id=job.id,
                provider=provider_name,
                dispatch_key=f"disp:{job.id}:1",
                provider_job_id=None,
                attempt=1,
                lease_owner=None,
                lease_until=None,
                lease_epoch=0,
                state="queued",
                next_poll_at=now,
                last_error=None,
            )
        )
        usage.queued_jobs += 1
        append_job_event(db, ctx.workspace_id, job)

    usage.version += 1
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "submitBatch", projectId, idempotency_key, digest, run.id, 202
    )
    db.commit()
    return _build_batch_out(db, run)


@router.get("/batches/{batchId}", response_model=BatchOut)
def get_batch(
    batchId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> BatchOut:
    run = db.scalar(
        select(RunRecord).where(
            RunRecord.id == batchId,
            RunRecord.workspace_id == ctx.workspace_id,
            RunRecord.kind == "batch",
        )
    )
    if not run:
        raise AppError(404, "NOT_FOUND", "批次任务不存在或无权访问")
    return _build_batch_out(db, run)


@router.get("/batches/{batchId}/download")
def download_batch(
    batchId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> Response:
    run = db.scalar(
        select(RunRecord).where(
            RunRecord.id == batchId,
            RunRecord.workspace_id == ctx.workspace_id,
            RunRecord.kind == "batch",
        )
    )
    if not run:
        raise AppError(404, "NOT_FOUND", "批次任务不存在或无权访问")

    _, _, allow_download = get_effective_project_permissions(db, ctx, run.project_id)
    if not allow_download:
        raise AppError(403, "READ_ONLY", "当前角色未被授权下载该项目的批量产出素材")

    jobs = list(
        db.scalars(
            select(JobRecord)
            .where(
                JobRecord.batch_id == run.id,
                JobRecord.workspace_id == ctx.workspace_id,
                JobRecord.project_id == run.project_id,
                JobRecord.state == "succeeded",
            )
            .order_by(JobRecord.created_at.asc(), JobRecord.id.asc())
        ).all()
    )
    if not jobs:
        raise AppError(409, "BATCH_NOT_READY", "当前批次尚无已成功的产出素材可供打包下载")

    billing_state = build_billing_state(db, ctx.workspace_id)
    needs_watermark = billing_state.entitlements.watermark
    storage = PrivateObjectStorage()

    tmp_zip = tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024, mode="w+b")
    written_count = 0
    try:
        with zipfile.ZipFile(tmp_zip, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for idx, j in enumerate(jobs, start=1):
                params = (j.frozen_input or {}).get("parameters") or {}
                aspect = str(params.get("aspectRatio", "1x1")).replace(":", "x")
                preset_id = params.get("platformPresetId") or params.get("outputKind") or "scene"
                for aid in j.result_refs or []:
                    asset = db.scalar(
                        select(AssetRecord).where(
                            AssetRecord.id == aid,
                            AssetRecord.workspace_id == ctx.workspace_id,
                            AssetRecord.project_id == run.project_id,
                            AssetRecord.state == "ready",
                        )
                    )
                    if not asset:
                        continue
                    target_path, _, _ = resolve_asset_delivery_variant(
                        db, storage, asset, needs_watermark
                    )
                    ext = "mp4" if asset.media_kind == "video" else "png"
                    arcname = f"{idx:02d}_{preset_id}_{aspect}_{asset.id}.{ext}"
                    zf.write(target_path, arcname=arcname)
                    written_count += 1
        if written_count == 0:
            tmp_zip.close()
            raise AppError(409, "BATCH_NOT_READY", "当前批次尚无已就绪的产出素材可供打包下载")
        tmp_zip.seek(0, io.SEEK_END)
        zip_size = tmp_zip.tell()
        tmp_zip.seek(0)
    except Exception:
        tmp_zip.close()
        raise

    def _iter_zip():
        try:
            while True:
                chunk = tmp_zip.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            tmp_zip.close()

    return StreamingResponse(
        _iter_zip(),
        status_code=200,
        media_type="application/zip",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'attachment; filename="batch_{run.id}.zip"',
            "Content-Length": str(zip_size),
            "X-Lingmao-Watermark": "free-tier" if needs_watermark else "none",
        },
    )


@router.post("/canvases/{canvasId}/run-quotes", response_model=RunQuoteOut, status_code=201)
def quote_graph(
    canvasId: str,
    body: RunQuoteInput,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> RunQuoteOut:
    canvas = db.scalar(
        select(CanvasRecord).where(
            CanvasRecord.id == canvasId,
            CanvasRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not canvas:
        raise AppError(404, "NOT_FOUND", "画布不存在或无权访问")
    require_project_access(db, ctx, canvas.project_id, write=True)

    if canvas.revision != body.baseRevision:
        raise AppError(
            409,
            "CANVAS_CONFLICT",
            f"画布版本落后：期望 baseRevision={body.baseRevision}，当前={canvas.revision}",
            details={"currentRevision": canvas.revision},
        )

    _ensure_provider_ready()
    graph = Graph.model_validate(canvas.graph)
    node_map = {n.id: n for n in graph.nodes}

    target_set = set(body.nodeIds)
    for nid in body.nodeIds:
        n = node_map.get(nid)
        if not n or n.type != "generation":
            raise AppError(422, "INVALID_GRAPH", f"运行目标节点 {nid} 不存在或不是 generation 节点")

    # Build topological order of requested generation nodes
    in_edges_by_target: dict[str, list[Any]] = {nid: [] for nid in node_map}
    for e in graph.edges:
        in_edges_by_target[e.target].append(e)

    deps_map: dict[str, list[str]] = {}
    for nid in body.nodeIds:
        deps = [
            e.source
            for e in in_edges_by_target.get(nid, [])
            if e.source in target_set
        ]
        deps_map[nid] = sorted(set(deps))

    # Kahn's topological sort on target_set
    in_deg = {nid: len(deps_map[nid]) for nid in body.nodeIds}
    queue = [nid for nid in body.nodeIds if in_deg[nid] == 0]
    topo_order: list[str] = []
    while queue:
        u = queue.pop(0)
        topo_order.append(u)
        for v in body.nodeIds:
            if u in deps_map[v]:
                in_deg[v] -= 1
                if in_deg[v] == 0:
                    queue.append(v)

    if len(topo_order) != len(body.nodeIds):
        raise AppError(422, "INVALID_GRAPH", "运行节点集合存在循环依赖")

    settings = get_settings()
    now = utcnow()
    expires_at = now + timedelta(seconds=int(settings.quote_ttl_seconds))
    quote_id = f"rquote-{uuid.uuid4().hex[:14]}"

    quote_items: list[QuoteItemRecord] = []
    steps_out: list[RunQuoteStepOut] = []
    total_credits = 0

    for ordinal, nid in enumerate(topo_order):
        gnode = node_map[nid]
        cfg = gnode.config
        mode = gnode.mode or "product_scene"
        model_id = (cfg.modelId if cfg and cfg.modelId else None) or (
            "studio-video" if mode in ("image_to_video", "text_to_video", "video_compose") else "studio-image"
        )
        prompt = (cfg.prompt if cfg and cfg.prompt else None) or gnode.label or "画布节点生成"
        params = (cfg.parameters if cfg and cfg.parameters else None) or Parameters(
            aspectRatio="1:1",
            durationSeconds=5 if mode in ("image_to_video", "text_to_video") else None,
        )

        # Gather static upstream asset/text/subject inputs
        static_assets: list[str] = []
        subject_id = params.subjectId
        mask_id = params.maskAssetId
        for e in in_edges_by_target.get(nid, []):
            src_node = node_map.get(e.source)
            if not src_node:
                continue
            if src_node.type == "asset" and src_node.assetId:
                if e.role == "mask":
                    mask_id = src_node.assetId
                else:
                    static_assets.append(src_node.assetId)
            elif src_node.type == "subject" and src_node.subjectId:
                subject_id = src_node.subjectId
                subj = db.get(SubjectRecord, subject_id)
                if subj:
                    sver = db.get(SubjectVersionRecord, (subj.id, subj.current_version))
                    if sver and sver.primary_asset_id not in static_assets:
                        static_assets.append(sver.primary_asset_id)
                    if sver and sver.mask_asset_id and not mask_id:
                        mask_id = sver.mask_asset_id
            elif src_node.type == "text" and src_node.text:
                prompt = src_node.text

        _check_content_safety(prompt)
        model = db.scalar(
            select(ModelCatalogRecord)
            .where(ModelCatalogRecord.id == model_id, ModelCatalogRecord.active.is_(True))
            .order_by(ModelCatalogRecord.version.desc())
        )
        if not model:
            raise AppError(422, "INVALID_GRAPH", f"节点 {nid} 的模型 {model_id} 不可用")

        cost = _calculate_item_cost(mode, model, params)
        params_dump = params.model_dump(exclude_none=True)
        if subject_id:
            params_dump["subjectId"] = subject_id
        if mask_id:
            params_dump["maskAssetId"] = mask_id

        binding = {
            "mode": mode,
            "modelId": model_id,
            "prompt": prompt,
            "inputAssetIds": static_assets,
            "parameters": params_dump,
            "canvasId": canvas.id,
            "nodeId": nid,
        }
        qi = QuoteItemRecord(
            id=f"qi-{uuid.uuid4().hex[:14]}",
            quote_id=quote_id,
            ordinal=ordinal,
            node_id=nid,
            aspect_ratio=params.aspectRatio,
            input_bindings=binding,
            cost=cost,
        )
        quote_items.append(qi)
        steps_out.append(
            RunQuoteStepOut(
                nodeId=nid,
                dependsOn=deps_map[nid],
                credits=cost,
            )
        )
        total_credits += cost

    quote = QuoteRecord(
        id=quote_id,
        workspace_id=ctx.workspace_id,
        project_id=canvas.project_id,
        canvas_id=canvas.id,
        created_by=ctx.user_id,
        kind="graph",
        pricing_version="test-rate-v1",
        frozen_request={
            "canvasId": canvas.id,
            "baseRevision": canvas.revision,
            "nodeIds": topo_order,
            "depsMap": deps_map,
        },
        canvas_revision=canvas.revision,
        total_credits=total_credits,
        expires_at=expires_at,
        consumed_at=None,
        created_at=now,
    )
    db.add(quote)
    db.flush()
    for qi in quote_items:
        db.add(qi)
    db.commit()

    return RunQuoteOut(
        id=quote.id,
        canvasId=canvas.id,
        baseRevision=canvas.revision,
        steps=steps_out,
        totalCredits=total_credits,
        expiresAt=iso_utc(expires_at) or "",
    )


def _build_run_out(db: Session, run: RunRecord) -> RunOut:
    steps = list(
        db.scalars(
            select(RunStepRecord)
            .where(RunStepRecord.run_id == run.id)
            .order_by(RunStepRecord.id.asc())
        ).all()
    )
    steps_out: list[RunStepOut] = []
    charged = 0
    for s in steps:
        out_assets: list[str] = []
        if s.job_id:
            j = db.get(JobRecord, s.job_id)
            if j:
                out_assets = list(j.result_refs or [])
            res = db.scalar(select(ReservationRecord).where(ReservationRecord.job_id == s.job_id))
            if res and res.state == "captured":
                charged += int(res.actual)
        steps_out.append(
            RunStepOut(
                nodeId=s.node_id or "",
                state=s.state,  # type: ignore[arg-type]
                jobId=s.job_id,
                outputAssetIds=out_assets,
            )
        )
    return RunOut(
        id=run.id,
        canvasId=run.canvas_id or "",
        baseRevision=int(run.base_revision or 1),
        status=run.status,  # type: ignore[arg-type]
        steps=steps_out,
        chargedCredits=charged,
    )


@router.post("/canvases/{canvasId}/runs", response_model=RunOut, status_code=202)
def submit_graph(
    canvasId: str,
    body: JobCreate,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> RunOut:
    canvas = db.scalar(
        select(CanvasRecord).where(
            CanvasRecord.id == canvasId,
            CanvasRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not canvas:
        raise AppError(404, "NOT_FOUND", "画布不存在或无权访问")
    require_project_access(db, ctx, canvas.project_id, write=True)
    provider_name = _ensure_provider_ready()
    usage = lock_workspace_usage(db, ctx.workspace_id)

    digest = canonical_digest(body.model_dump())
    existing_key = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "submitGraph", canvasId, idempotency_key, digest
    )
    if existing_key:
        existing_run = db.get(RunRecord, existing_key.resource_id)
        if existing_run:
            return _build_run_out(db, existing_run)

    quote = db.scalar(
        select(QuoteRecord)
        .where(
            QuoteRecord.id == body.quoteId,
            QuoteRecord.workspace_id == ctx.workspace_id,
            QuoteRecord.canvas_id == canvasId,
            QuoteRecord.kind == "graph",
        )
        .with_for_update()
    )
    if not quote:
        raise AppError(404, "NOT_FOUND", f"画布运行报价 {body.quoteId} 不存在")
    if quote.consumed_at is not None:
        orig_run = db.scalar(select(RunRecord).where(RunRecord.quote_id == quote.id))
        raise AppError(
            409,
            "QUOTE_USED",
            "该画布报价已被消费",
            details={"quoteId": quote.id, "runId": orig_run.id if orig_run else None},
        )
    now = utcnow()
    if quote.expires_at <= now:
        raise AppError(410, "QUOTE_EXPIRED", "画布运行报价已过期")

    q_items = list(
        db.scalars(
            select(QuoteItemRecord)
            .where(QuoteItemRecord.quote_id == quote.id)
            .order_by(QuoteItemRecord.ordinal.asc())
            .with_for_update()
        ).all()
    )
    deps_map: dict[str, list[str]] = (quote.frozen_request or {}).get("depsMap") or {}

    run_id = f"run-{uuid.uuid4().hex[:14]}"
    run = RunRecord(
        id=run_id,
        workspace_id=ctx.workspace_id,
        project_id=canvas.project_id,
        canvas_id=canvas.id,
        base_revision=quote.canvas_revision or canvas.revision,
        kind="graph",
        quote_id=quote.id,
        status="running",
        graph_snapshot=canvas.graph,
        created_at=now,
        updated_at=now,
    )
    db.add(run)
    db.flush()

    reservation_specs: list[tuple[str, int, str | None]] = []
    root_jobs: list[JobRecord] = []

    for idx, qi in enumerate(q_items):
        nid = qi.node_id or f"node-{idx}"
        deps = deps_map.get(nid, [])
        if not deps:
            job_id = f"job-{uuid.uuid4().hex[:14]}"
            job = JobRecord(
                id=job_id,
                workspace_id=ctx.workspace_id,
                project_id=canvas.project_id,
                quote_item_id=qi.id,
                run_id=run.id,
                batch_id=None,
                canvas_id=canvas.id,
                node_id=nid,
                retry_of_job_id=None,
                state="queued",
                revision=1,
                frozen_input=qi.input_bindings,
                result_refs=[],
                progress=0,
                cancel_requested=False,
                error_code=None,
                priority=0,
                not_before=now,
                created_at=now,
                updated_at=now,
                deadline_at=now + timedelta(minutes=15),
            )
            db.add(job)
            root_jobs.append(job)
            reservation_specs.append((qi.id, int(qi.cost), job.id))
            db.add(
                RunStepRecord(
                    id=f"stp-{idx:03d}-{uuid.uuid4().hex[:10]}",
                    run_id=run.id,
                    node_id=nid,
                    quote_item_id=qi.id,
                    state="queued",
                    input_bindings=qi.input_bindings,
                    depends_on=[],
                    job_id=job.id,
                )
            )
        else:
            reservation_specs.append((qi.id, int(qi.cost), None))
            db.add(
                RunStepRecord(
                    id=f"stp-{idx:03d}-{uuid.uuid4().hex[:10]}",
                    run_id=run.id,
                    node_id=nid,
                    quote_item_id=qi.id,
                    state="waiting",
                    input_bindings=qi.input_bindings,
                    depends_on=deps,
                    job_id=None,
                )
            )

    db.flush()
    reserve_credits_for_items(db, ctx.workspace_id, reservation_specs)
    quote.consumed_at = now

    for job in root_jobs:
        db.add(
            ProviderDispatchRecord(
                id=f"dsp-{uuid.uuid4().hex[:14]}",
                workspace_id=ctx.workspace_id,
                job_id=job.id,
                provider=provider_name,
                dispatch_key=f"disp:{job.id}:1",
                provider_job_id=None,
                attempt=1,
                lease_owner=None,
                lease_until=None,
                lease_epoch=0,
                state="queued",
                next_poll_at=now,
                last_error=None,
            )
        )
        usage.queued_jobs += 1
        append_job_event(db, ctx.workspace_id, job)

    usage.version += 1
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "submitGraph", canvasId, idempotency_key, digest, run.id, 202
    )
    db.commit()
    return _build_run_out(db, run)


@router.get("/runs/{runId}", response_model=RunOut)
def get_graph_run(
    runId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> RunOut:
    run = db.scalar(
        select(RunRecord).where(
            RunRecord.id == runId,
            RunRecord.workspace_id == ctx.workspace_id,
            RunRecord.kind == "graph",
        )
    )
    if not run:
        raise AppError(404, "NOT_FOUND", "画布运行记录不存在或无权访问")
    return _build_run_out(db, run)


@router.post("/generation/webhooks/{provider}", status_code=202)
async def receive_generation_event(
    provider: str,
    request: Request,
    provider_signature: str | None = Header(default=None, alias="Provider-Signature"),
    db: Session = Depends(get_db),
) -> Response:
    secret = validate_generation_webhook_secret()
    _ensure_provider_ready()
    raw_body = await request.body()
    if not verify_webhook_signature(raw_body, provider_signature, secret):
        raise AppError(400, "INVALID_SIGNATURE", "生成供应商回调签名验证失败")

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise AppError(400, "INVALID_PAYLOAD", f"无效的回调 JSON: {exc}") from exc

    event_key = str(payload.get("eventId") or payload.get("event_key") or sha256_hex(raw_body))
    provider_job_id = payload.get("providerJobId")
    job_id = payload.get("jobId")
    event_status = str(payload.get("status") or "").lower()
    error_code = payload.get("errorCode") or "PROVIDER_FAILURE"

    if not job_id and not provider_job_id:
        raise AppError(400, "MISSING_JOB_REFERENCE", "回调缺少 jobId 或 providerJobId")

    now = utcnow()
    payload_digest = sha256_hex(raw_body)
    inbox = db.get(ProviderInboxRecord, (provider, event_key))
    if inbox is not None and inbox.processed_at is not None:
        return Response(status_code=202)

    if inbox is None:
        inbox = ProviderInboxRecord(
            provider=provider,
            event_key=event_key,
            provider_job_id=provider_job_id,
            payload_digest=payload_digest,
            body=payload,
            received_at=now,
            processed_at=None,
            attempts=1,
        )
        db.add(inbox)
        db.flush()
    else:
        inbox.attempts += 1

    # Locate target job
    job: JobRecord | None = None
    if job_id:
        job = db.scalar(select(JobRecord).where(JobRecord.id == str(job_id)).with_for_update())
    elif provider_job_id:
        disp = db.scalar(
            select(ProviderDispatchRecord).where(
                ProviderDispatchRecord.provider == provider,
                ProviderDispatchRecord.provider_job_id == str(provider_job_id),
            )
        )
        if disp:
            job = db.scalar(select(JobRecord).where(JobRecord.id == disp.job_id).with_for_update())

    if not job:
        # Unknown provider job id: persist in inbox and acknowledge 202 without crashing
        inbox.processed_at = now
        db.commit()
        return Response(status_code=202)

    # Terminal CAS and out-of-order handling
    if event_status == "running":
        transition_job_to_running(
            db,
            job.id,
            provider_job_id=str(provider_job_id) if provider_job_id else None,
            progress=int(payload.get("progress", 50)),
        )
    elif event_status == "succeeded":
        if job.state not in ("succeeded", "failed", "cancelled"):
            # Materialize output via deterministic adapter before committing succeeded state
            adapter = DeterministicDemoGenerationAdapter()
            frozen_in = job.frozen_input or {}
            in_assets = []
            for aid in frozen_in.get("inputAssetIds") or []:
                a = db.get(AssetRecord, aid)
                if a:
                    in_assets.append({"id": a.id, "object_key": a.object_key, "sha256": a.sha256})
            materialized = adapter.materialize(
                workspace_id=job.workspace_id,
                project_id=job.project_id,
                job_id=job.id,
                dispatch_key=f"webhook:{job.id}",
                frozen_input=frozen_in,
                input_assets=in_assets,
            )
            if provider_job_id:
                materialized.provider_job_id = str(provider_job_id)
            settle_job_succeeded(db, job.id, materialized)
    elif event_status in ("failed", "timeout", "expired"):
        code = "JOB_TIMEOUT" if event_status in ("timeout", "expired") else str(error_code)
        settle_job_terminal_failure_or_cancel(db, job.id, target_state="failed", error_code=code)
    elif event_status == "cancelled":
        settle_job_terminal_failure_or_cancel(db, job.id, target_state="cancelled", error_code=None)

    inbox.processed_at = utcnow()
    db.commit()
    return Response(status_code=202)
