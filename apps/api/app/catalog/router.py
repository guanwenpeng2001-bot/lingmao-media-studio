from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session
from app.auth.deps import (
    AuthContext,
    get_current_context,
    get_optional_context,
    require_project_access,
)
from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import (
    AssetRecord,
    ModelCatalogRecord,
    PlatformPresetRecord,
    PortraitCatalogRecord,
    TemplateRecord,
)
from app.schemas import (
    Cue,
    Edge,
    Graph,
    ModelOut,
    Node,
    NodeConfig,
    Parameters,
    PortraitOptionsOut,
    PortraitOut,
    Position,
    PresetOut,
    Shot,
    StoryboardOut,
    StoryboardRequest,
    TemplateOut,
    Viewport,
)

router = APIRouter()

GATED_TRYON_MODES = {"try_on", "hand_held", "worn"}


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(
    industry: str | None = Query(default=None),
    q: str | None = Query(default=None, max_length=128),
    ctx: AuthContext | None = Depends(get_optional_context),
    db: Session = Depends(get_db),
) -> list[TemplateOut]:
    settings = get_settings()
    stmt = select(TemplateRecord)
    if ctx is None:
        stmt = stmt.where(TemplateRecord.scope == "official")
    else:
        allowed_scopes = ["personal"]
        if settings.feature_org_collaboration:
            allowed_scopes.append("team")
        stmt = stmt.where(
            or_(
                TemplateRecord.scope == "official",
                (TemplateRecord.workspace_id == ctx.workspace_id)
                & (TemplateRecord.scope.in_(allowed_scopes)),
            )
        )
    if industry:
        stmt = stmt.where(TemplateRecord.industry == industry)
    rows = list(db.scalars(stmt.order_by(TemplateRecord.created_at.desc(), TemplateRecord.id.asc())).all())

    result: list[TemplateOut] = []
    for t in rows:
        if q and q.lower() not in t.name.lower() and not any(q.lower() in tag.lower() for tag in (t.tags or [])):
            continue
        modes = [
            m for m in (t.suggested_modes or [])
            if settings.feature_virtual_tryon or m not in GATED_TRYON_MODES
        ]
        result.append(
            TemplateOut(
                id=t.id,
                version=int(t.version),
                name=t.name,
                industry=t.industry,
                prompt=t.prompt,
                suggestedModes=modes,  # type: ignore[arg-type]
                aspectRatio=t.aspect_ratio,
                tags=list(t.tags or []),
                visibility=t.scope,  # type: ignore[arg-type]
            )
        )
    return result


@router.get("/models", response_model=list[ModelOut])
def list_models(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[ModelOut]:
    settings = get_settings()
    rows = list(
        db.scalars(
            select(ModelCatalogRecord)
            .where(ModelCatalogRecord.active.is_(True))
            .order_by(ModelCatalogRecord.id.asc())
        ).all()
    )
    execution = "demo" if settings.is_demo_inference else "live"
    availability = "available" if (settings.is_demo_inference or settings.has_live_inference) else "unconfigured"

    result: list[ModelOut] = []
    for m in rows:
        modes = [
            mode for mode in (m.modes or [])
            if settings.feature_virtual_tryon or mode not in GATED_TRYON_MODES
        ]
        if not modes:
            continue
        out = ModelOut(
            id=m.id,
            label=m.label,
            modes=modes,  # type: ignore[arg-type]
            aspectRatios=list(m.aspect_ratios or ["1:1"]),
            durationSeconds=list(m.duration_seconds or []),
            maxInputImages=int(m.max_input_images),
            availability=availability,  # type: ignore[arg-type]
            execution=execution,  # type: ignore[arg-type]
            resolutions=list(m.resolutions or ["1k"]),
            nativeAudio=bool(m.native_audio),
            supportsLastFrame=bool(m.supports_last_frame),
            supportsLockedSubject=bool(m.supports_locked_subject),
            submissionRecovery=m.submission_recovery,  # type: ignore[arg-type]
            maxInputClips=int(m.max_input_clips) if m.max_input_clips else 0,
        )
        result.append(out)
    return result


@router.get("/ecommerce/presets", response_model=list[PresetOut])
def get_platform_presets(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[PresetOut]:
    rows = list(db.scalars(select(PlatformPresetRecord).order_by(PlatformPresetRecord.id.asc())).all())
    return [
        PresetOut(
            id=p.id,
            platform=p.platform,
            name=p.name,
            aspectRatio=p.aspect_ratio,
            width=int(p.width),
            height=int(p.height),
            safeArea=dict(p.safe_area),
            version=int(p.version),
        )
        for p in rows
    ]


@router.get("/ecommerce/portraits", response_model=list[PortraitOut])
def get_portrait_catalog(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[PortraitOut]:
    settings = get_settings()
    if not settings.feature_virtual_tryon:
        raise AppError(404, "FEATURE_DISABLED", "虚拟模特与试穿功能 (virtual_tryon) 在当前版本未启用")
    rows = list(db.scalars(select(PortraitCatalogRecord).order_by(PortraitCatalogRecord.id.asc())).all())
    return [
        PortraitOut(
            id=r.id,
            label=r.label,
            previewUrl=r.preview_asset,
            licenseVersion=r.license_version,
            usage=list(r.allowed_uses or ["try_on"]),  # type: ignore[arg-type]
            options=PortraitOptionsOut.model_validate(r.attributes or {}),
        )
        for r in rows
    ]


@router.post("/projects/{projectId}/storyboards", response_model=StoryboardOut)
def draft_storyboard(
    projectId: str,
    body: StoryboardRequest,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> StoryboardOut:
    require_project_access(db, ctx, projectId, write=True)
    asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.id == body.inputAssetId,
            AssetRecord.workspace_id == ctx.workspace_id,
            AssetRecord.project_id == projectId,
            AssetRecord.state == "ready",
        )
    )
    if not asset:
        raise AppError(404, "NOT_FOUND", "分镜引用的输入素材不存在或不可用")

    motions = ["push_in", "pan_right", "orbit_slow", "pull_out"]
    shots: list[Shot] = []
    cues: list[Cue] = []
    nodes: list[Node] = [
        Node(
            id="node-input-asset",
            type="asset",
            position=Position(x=80, y=220),
            assetId=asset.id,
            label=asset.name,
        )
    ]
    edges: list[Edge] = []
    cursor_ms = 0

    for idx in range(body.shotCount):
        point = body.sellingPoints[idx % len(body.sellingPoints)]
        motion = motions[idx % len(motions)]
        dur_sec = 5
        shot_prompt = f"镜头 {idx + 1}：{point}，保持商品主体特征稳定，运镜 {motion}。"
        shots.append(
            Shot(
                caption=point,
                prompt=shot_prompt,
                durationSeconds=dur_sec,
                cameraMotion=motion,
            )
        )
        start_ms = cursor_ms
        end_ms = cursor_ms + dur_sec * 1000
        cursor_ms = end_ms
        cues.append(Cue(startMs=start_ms, endMs=end_ms, text=point))

        node_id = f"node-shot-{idx + 1}"
        nodes.append(
            Node(
                id=node_id,
                type="generation",
                position=Position(x=420, y=100 + idx * 160),
                mode="image_to_video",
                label=f"分镜 {idx + 1}",
                config=NodeConfig(
                    modelId="studio-video",
                    prompt=shot_prompt,
                    parameters=Parameters(
                        aspectRatio=body.aspectRatio,
                        durationSeconds=dur_sec,
                        cameraMotion=motion,
                        nativeAudio=False,
                    ),
                ),
            )
        )
        edges.append(
            Edge(
                id=f"edge-shot-{idx + 1}",
                source="node-input-asset",
                target=node_id,
                role="first_frame",
                ordinal=0,
            )
        )

    graph = Graph(
        schemaVersion=1,
        nodes=nodes,
        edges=edges,
        viewport=Viewport(x=0, y=0, zoom=1.0),
    )
    return StoryboardOut(shots=shots, graph=graph, cues=cues)
