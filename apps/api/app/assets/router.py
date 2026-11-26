from __future__ import annotations

import uuid
from datetime import timedelta
from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.auth.deps import (
    AuthContext,
    canonical_digest,
    check_request_idempotency,
    get_current_context,
    get_effective_project_permissions,
    require_project_access,
    save_request_idempotency,
)
from app.billing.ledger import build_billing_state, lock_workspace_usage
from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import (
    AssetInputRecord,
    AssetRecord,
    AssetVariantRecord,
    CanvasAssetRef,
    JobRecord,
    PortraitConsentRecord,
    SubjectRecord,
    SubjectVersionRecord,
    utcnow,
)
from app.providers.storage import PrivateObjectStorage, inspect_media_bytes
from app.schemas import (
    AssetImpact,
    AssetOut,
    AssetPage,
    AssetPatch,
    ExportLicense,
    PortraitConsentCreate,
    PortraitConsentOut,
    SubjectCreate,
    SubjectOut,
    SubjectUpdate,
    iso_utc,
)

router = APIRouter()


def build_asset_out(db: Session, asset: AssetRecord) -> AssetOut:
    inputs = list(
        db.scalars(
            select(AssetInputRecord.input_asset_id)
            .where(AssetInputRecord.output_asset_id == asset.id)
            .order_by(AssetInputRecord.ordinal.asc(), AssetInputRecord.role.asc())
        ).all()
    )
    ref_count = db.scalar(
        select(func.count(func.distinct(CanvasAssetRef.canvas_id)))
        .where(CanvasAssetRef.asset_id == asset.id)
    ) or 0
    dur_sec = round(asset.duration_ms / 1000.0, 3) if asset.duration_ms and asset.duration_ms > 0 else None
    return AssetOut(
        id=asset.id,
        projectId=asset.project_id,
        kind=asset.media_kind,  # type: ignore[arg-type]
        name=asset.name,
        mimeType=asset.content_type,
        origin=asset.origin,  # type: ignore[arg-type]
        status=asset.state,  # type: ignore[arg-type]
        sourceJobId=asset.source_job_id,
        inputAssetIds=inputs,
        byteSize=int(asset.byte_size),
        width=asset.width,
        height=asset.height,
        durationSeconds=dur_sec,
        createdAt=iso_utc(asset.created_at) or "",
        thumbnailUrl=f"/api/v1/assets/{asset.id}/content?disposition=preview",
        assetRole=asset.asset_role,  # type: ignore[arg-type]
        archivedAt=iso_utc(asset.archived_at),
        purgeAfter=iso_utc(asset.purge_after),
        metadata=dict(asset.metadata_json or {}),
        tags=list(asset.tags or []),
        referenceCount=int(ref_count),
    )


def _subject_to_out(subj: SubjectRecord, ver: SubjectVersionRecord) -> SubjectOut:
    return SubjectOut(
        id=subj.id,
        projectId=subj.project_id,
        name=subj.name,
        sku=subj.sku,
        primaryAssetId=ver.primary_asset_id,
        referenceAssetIds=list(ver.references_json or []),
        maskAssetId=ver.mask_asset_id,
        version=int(ver.version),
    )


def _verify_project_asset(
    db: Session,
    workspace_id: str,
    project_id: str,
    asset_id: str,
    require_image: bool = False,
) -> AssetRecord:
    asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.id == asset_id,
            AssetRecord.workspace_id == workspace_id,
            AssetRecord.project_id == project_id,
            AssetRecord.state == "ready",
        )
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", f"引用的项目素材 {asset_id} 不存在或已归档")
    if require_image and asset.media_kind != "image":
        raise AppError(422, "INVALID_INPUT", f"素材 {asset_id} 必须为图片类型")
    return asset


@router.get("/projects/{projectId}/subjects", response_model=list[SubjectOut])
def list_subjects(
    projectId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[SubjectOut]:
    require_project_access(db, ctx, projectId, write=False)
    subjects = list(
        db.scalars(
            select(SubjectRecord)
            .where(
                SubjectRecord.workspace_id == ctx.workspace_id,
                SubjectRecord.project_id == projectId,
            )
            .order_by(SubjectRecord.created_at.desc())
        ).all()
    )
    result: list[SubjectOut] = []
    for s in subjects:
        ver = db.get(SubjectVersionRecord, (s.id, s.current_version))
        if ver:
            result.append(_subject_to_out(s, ver))
    return result


@router.post("/projects/{projectId}/subjects", response_model=SubjectOut, status_code=201)
def create_subject(
    projectId: str,
    body: SubjectCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> SubjectOut:
    require_project_access(db, ctx, projectId, write=True)
    _verify_project_asset(db, ctx.workspace_id, projectId, body.primaryAssetId, require_image=True)
    for ref_id in body.referenceAssetIds:
        _verify_project_asset(db, ctx.workspace_id, projectId, ref_id, require_image=True)
    if body.maskAssetId:
        _verify_project_asset(db, ctx.workspace_id, projectId, body.maskAssetId, require_image=True)

    sku_clean = body.sku.strip() if body.sku else None
    if sku_clean:
        dup = db.scalar(
            select(SubjectRecord).where(
                SubjectRecord.project_id == projectId,
                SubjectRecord.sku == sku_clean,
            )
        )
        if dup:
            raise AppError(409, "DUPLICATE_SKU", f"同一项目下已存在 SKU {sku_clean}")

    now = utcnow()
    subj = SubjectRecord(
        id=f"sub-{uuid.uuid4().hex[:12]}",
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        name=body.name.strip(),
        sku=sku_clean,
        current_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(subj)
    db.flush()

    ver = SubjectVersionRecord(
        subject_id=subj.id,
        version=1,
        primary_asset_id=body.primaryAssetId,
        mask_asset_id=body.maskAssetId,
        references_json=list(body.referenceAssetIds),
        created_at=now,
    )
    db.add(ver)
    db.commit()
    return _subject_to_out(subj, ver)


@router.patch("/subjects/{subjectId}", response_model=SubjectOut)
def update_subject(
    subjectId: str,
    body: SubjectUpdate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> SubjectOut:
    subj = db.scalar(
        select(SubjectRecord)
        .where(
            SubjectRecord.id == subjectId,
            SubjectRecord.workspace_id == ctx.workspace_id,
        )
        .with_for_update()
    )
    if not subj:
        raise AppError(404, "NOT_FOUND", "商品主体不存在或无权访问")
    require_project_access(db, ctx, subj.project_id, write=True)

    if subj.current_version != body.baseVersion:
        raise AppError(
            409,
            "SUBJECT_CONFLICT",
            f"商品主体版本冲突：期望基线 {body.baseVersion}，当前版本 {subj.current_version}",
            details={"currentVersion": subj.current_version, "subjectId": subj.id},
        )

    cur_ver = db.get(SubjectVersionRecord, (subj.id, subj.current_version))
    assert cur_ver is not None

    new_refs = list(body.referenceAssetIds) if body.referenceAssetIds is not None else list(cur_ver.references_json)
    for ref_id in new_refs:
        _verify_project_asset(db, ctx.workspace_id, subj.project_id, ref_id, require_image=True)

    new_mask = body.maskAssetId if body.maskAssetId is not None else cur_ver.mask_asset_id
    if new_mask:
        _verify_project_asset(db, ctx.workspace_id, subj.project_id, new_mask, require_image=True)

    if body.name is not None:
        subj.name = body.name.strip()
    new_version_num = subj.current_version + 1
    subj.current_version = new_version_num
    subj.updated_at = utcnow()

    new_ver = SubjectVersionRecord(
        subject_id=subj.id,
        version=new_version_num,
        primary_asset_id=cur_ver.primary_asset_id,
        mask_asset_id=new_mask,
        references_json=new_refs,
        created_at=utcnow(),
    )
    db.add(new_ver)
    db.commit()
    return _subject_to_out(subj, new_ver)


@router.get("/assets", response_model=AssetPage)
def list_assets(
    project_id: str | None = Query(default=None, alias="projectId"),
    kind: str | None = Query(default=None),
    status: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    tag: str | None = Query(default=None, max_length=64),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> AssetPage:
    stmt = select(AssetRecord).where(AssetRecord.workspace_id == ctx.workspace_id)
    if project_id:
        stmt = stmt.where(AssetRecord.project_id == project_id)
    if kind:
        stmt = stmt.where(AssetRecord.media_kind == kind)
    if status:
        stmt = stmt.where(AssetRecord.state == status)
    stmt = stmt.order_by(AssetRecord.created_at.desc(), AssetRecord.id.desc())
    rows = list(db.scalars(stmt).all())
    if tag:
        rows = [r for r in rows if tag in (r.tags or [])]

    start_idx = 0
    if cursor:
        for idx, r in enumerate(rows):
            if r.id == cursor:
                start_idx = idx + 1
                break
    page = rows[start_idx : start_idx + limit]
    next_cursor = page[-1].id if len(rows) > start_idx + limit and page else None
    return AssetPage(items=[build_asset_out(db, a) for a in page], nextCursor=next_cursor)


@router.post("/projects/{projectId}/assets", response_model=AssetOut, status_code=201)
async def upload_asset(
    projectId: str,
    file: UploadFile = File(...),
    assetRole: str | None = Form(default=None),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> AssetOut:
    require_project_access(db, ctx, projectId, write=True)
    role = assetRole or "product"
    if role not in ("reference", "mask", "product", "other"):
        raise AppError(422, "INVALID_INPUT", f"不支持的上传素材角色: {role}")

    raw_bytes = await file.read()
    filename = (file.filename or "upload.bin").strip()
    inspected = inspect_media_bytes(raw_bytes, filename=filename)

    usage = lock_workspace_usage(db, ctx.workspace_id)
    digest = canonical_digest(
        {
            "projectId": projectId,
            "sha256": inspected.sha256,
            "filename": filename,
            "assetRole": role,
        }
    )
    existing_key = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "uploadAsset", projectId, idempotency_key, digest
    )
    if existing_key:
        existing_asset = db.get(AssetRecord, existing_key.resource_id)
        if existing_asset:
            return build_asset_out(db, existing_asset)

    billing_state = build_billing_state(db, ctx.workspace_id)
    if int(usage.used_bytes) + inspected.byte_size > billing_state.entitlements.storageLimitBytes:
        raise AppError(
            409,
            "STORAGE_LIMIT",
            "工作空间私有存储容量不足",
            details={
                "usedBytes": int(usage.used_bytes),
                "requiredBytes": inspected.byte_size,
                "limitBytes": billing_state.entitlements.storageLimitBytes,
            },
        )

    ext_map = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "audio/wav": "wav",
        "audio/mpeg": "mp3",
    }
    ext = ext_map.get(inspected.content_type, "bin")
    asset_id = f"ast-{uuid.uuid4().hex[:14]}"
    object_key = f"{ctx.workspace_id}/{projectId}/uploads/{asset_id}_{inspected.sha256[:12]}.{ext}"

    storage = PrivateObjectStorage()
    storage.put_bytes(object_key, inspected.normalized_bytes)

    now = utcnow()
    asset = AssetRecord(
        id=asset_id,
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        name=filename[:256],
        media_kind=inspected.media_kind,
        asset_role=role,
        origin="upload",
        state="ready",
        source_job_id=None,
        output_index=None,
        object_key=object_key,
        sha256=inspected.sha256,
        content_type=inspected.content_type,
        byte_size=inspected.byte_size,
        width=inspected.width,
        height=inspected.height,
        duration_ms=inspected.duration_ms,
        metadata_json=inspected.metadata,
        tags=[],
        archived_at=None,
        purge_after=None,
        created_at=now,
    )
    db.add(asset)
    usage.used_bytes += inspected.byte_size
    usage.version += 1
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "uploadAsset", projectId, idempotency_key, digest, asset.id, 201
    )
    db.commit()
    return build_asset_out(db, asset)


@router.get("/assets/{assetId}", response_model=AssetOut)
def get_asset(
    assetId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> AssetOut:
    asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.id == assetId,
            AssetRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", "素材不存在或无权访问")
    return build_asset_out(db, asset)


def _compute_asset_impact(db: Session, workspace_id: str, asset: AssetRecord) -> tuple[int, int]:
    canvas_cnt = int(
        db.scalar(
            select(func.count(func.distinct(CanvasAssetRef.canvas_id)))
            .where(
                CanvasAssetRef.workspace_id == workspace_id,
                CanvasAssetRef.asset_id == asset.id,
            )
        ) or 0
    )
    active_jobs = list(
        db.scalars(
            select(JobRecord).where(
                JobRecord.workspace_id == workspace_id,
                JobRecord.state.in_(["queued", "running"]),
            )
        ).all()
    )
    active_cnt = 0
    for j in active_jobs:
        fi = j.frozen_input or {}
        in_ids = list(fi.get("inputAssetIds") or [])
        params = fi.get("parameters") or {}
        if params.get("maskAssetId"):
            in_ids.append(params["maskAssetId"])
        if params.get("lastFrameAssetId"):
            in_ids.append(params["lastFrameAssetId"])
        if asset.id in in_ids:
            active_cnt += 1
    return canvas_cnt, active_cnt


@router.get("/assets/{assetId}/impact", response_model=AssetImpact)
def get_archive_impact(
    assetId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> AssetImpact:
    asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.id == assetId,
            AssetRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", "素材不存在或无权访问")
    canvas_cnt, active_cnt = _compute_asset_impact(db, ctx.workspace_id, asset)
    return AssetImpact(
        referencingCanvasCount=canvas_cnt,
        activeJobs=active_cnt,
        purgeAfter=iso_utc(asset.purge_after),
    )


@router.patch("/assets/{assetId}", response_model=AssetOut)
def archive_asset(
    assetId: str,
    body: AssetPatch,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> AssetOut:
    asset = db.scalar(
        select(AssetRecord)
        .where(
            AssetRecord.id == assetId,
            AssetRecord.workspace_id == ctx.workspace_id,
        )
        .with_for_update()
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", "素材不存在或无权访问")
    require_project_access(db, ctx, asset.project_id, write=True)

    if body.status == "archived" and asset.state != "archived":
        canvas_cnt, active_cnt = _compute_asset_impact(db, ctx.workspace_id, asset)
        if (canvas_cnt > 0 or active_cnt > 0) and not body.acknowledgeReferences:
            raise AppError(
                409,
                "ASSET_REFERENCED",
                "该素材正被画布或运行中任务引用，需确认归档影响",
                details={"referencingCanvasCount": canvas_cnt, "activeJobs": active_cnt},
            )
        now = utcnow()
        asset.state = "archived"
        asset.archived_at = now
        asset.purge_after = now + timedelta(days=30)
    elif body.status == "ready" and asset.state == "archived":
        asset.state = "ready"
        asset.archived_at = None
        asset.purge_after = None

    if body.name is not None:
        asset.name = body.name.strip()
    if body.tags is not None:
        asset.tags = list(body.tags)

    db.commit()
    return build_asset_out(db, asset)


@router.get("/assets/{assetId}/content")
def read_media(
    assetId: str,
    request: Request,
    disposition: str = Query(default="preview", pattern="^(preview|download)$"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> Response:
    asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.id == assetId,
            AssetRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", "素材不存在或无权访问")

    _, _, allow_download = get_effective_project_permissions(db, ctx, asset.project_id)
    if disposition == "download" and not allow_download:
        raise AppError(403, "READ_ONLY", "当前角色未被授权下载该项目的素材")

    billing_state = build_billing_state(db, ctx.workspace_id)
    needs_watermark = billing_state.entitlements.watermark
    storage = PrivateObjectStorage()

    if needs_watermark and asset.media_kind == "image" and asset.asset_role != "mask":
        variant_key = f"{asset.workspace_id}/{asset.project_id}/variants/{asset.id}_wm_v1.png"
        sha, size, data = storage.ensure_watermarked_image_variant(asset.object_key, variant_key)
        existing_var = db.scalar(
            select(AssetVariantRecord).where(
                AssetVariantRecord.asset_id == asset.id,
                AssetVariantRecord.kind == "watermarked",
                AssetVariantRecord.policy_version == "v1",
            )
        )
        if not existing_var:
            db.add(
                AssetVariantRecord(
                    id=f"var-{uuid.uuid4().hex[:12]}",
                    workspace_id=asset.workspace_id,
                    asset_id=asset.id,
                    kind="watermarked",
                    policy_version="v1",
                    object_key=variant_key,
                    sha256=sha,
                    byte_size=size,
                )
            )
            db.commit()
        watermark_header = "free-tier"
    else:
        data = storage.read_bytes(asset.object_key)
        watermark_header = "none"

    disp_type = "attachment" if disposition == "download" else "inline"
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Disposition": f'{disp_type}; filename="{asset.name}"',
        "X-Lingmao-Watermark": watermark_header,
        "X-Asset-Mime-Type": asset.content_type,
    }

    range_header = request.headers.get("range")
    total_len = len(data)
    if range_header and range_header.startswith("bytes="):
        try:
            range_spec = range_header[6:].split(",")[0].strip()
            start_s, end_s = range_spec.split("-", 1)
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else total_len - 1
            start = max(0, min(start, total_len - 1))
            end = max(start, min(end, total_len - 1))
            chunk = data[start : end + 1]
            headers["Content-Range"] = f"bytes {start}-{end}/{total_len}"
            headers["Content-Length"] = str(len(chunk))
            return Response(
                content=chunk,
                status_code=206,
                media_type="application/octet-stream",
                headers=headers,
            )
        except Exception:
            pass

    headers["Content-Length"] = str(total_len)
    return Response(
        content=data,
        status_code=200,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.get("/assets/{assetId}/license", response_model=ExportLicense)
def get_export_license(
    assetId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> ExportLicense:
    asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.id == assetId,
            AssetRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", "素材不存在或无权访问")
    billing_state = build_billing_state(db, ctx.workspace_id)
    now = utcnow()
    is_pro = not billing_state.entitlements.watermark
    label = "灵猫商业使用授权（Pro 无水印）" if is_pro else "灵猫体验预览授权（含试用标识）"
    terms_ver = "commercial-pro-v1" if is_pro else "trial-preview-v1"
    return ExportLicense(
        label=label,
        termsVersion=terms_ver,
        issuedAt=iso_utc(now) or "",
        assetIds=[asset.id],
        downloadUrl=f"/api/v1/assets/{asset.id}/content?disposition=download",
        expiresAt=iso_utc(now + timedelta(hours=24)) or "",
    )


@router.post("/projects/{projectId}/portrait-consents", response_model=PortraitConsentOut, status_code=201)
def record_portrait_consent(
    projectId: str,
    body: PortraitConsentCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> PortraitConsentOut:
    settings = get_settings()
    if not settings.feature_virtual_tryon:
        raise AppError(404, "FEATURE_DISABLED", "私人模特肖像授权 (virtual_tryon) 在当前版本未启用")
    require_project_access(db, ctx, projectId, write=True)
    _verify_project_asset(db, ctx.workspace_id, projectId, body.assetId, require_image=True)
    now = utcnow()
    rec = PortraitConsentRecord(
        id=f"cns-{uuid.uuid4().hex[:12]}",
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        asset_id=body.assetId,
        actor_id=ctx.user_id,
        terms_version=body.termsVersion,
        accepted_at=now,
    )
    db.add(rec)
    db.commit()
    return PortraitConsentOut(
        id=rec.id,
        assetId=rec.asset_id,
        termsVersion=rec.terms_version,
        recordedAt=iso_utc(rec.accepted_at) or "",
    )
