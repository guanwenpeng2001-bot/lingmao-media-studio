from __future__ import annotations

import copy
import uuid
from typing import Any
from fastapi import APIRouter, Depends, Query
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session
from app.auth.deps import (
    AuthContext,
    get_current_context,
    get_effective_project_permissions,
    require_project_access,
)
from app.billing.ledger import build_billing_state
from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import (
    AssetRecord,
    CanvasAssetRef,
    CanvasRecord,
    CanvasVisit,
    Project,
    SubjectRecord,
    TemplateRecord,
    utcnow,
)
from app.schemas import (
    CanvasCreate,
    CanvasOut,
    CanvasPage,
    CanvasSave,
    CanvasSummary,
    CloneCanvas,
    Graph,
    ProjectCreate,
    ProjectOut,
    ProjectPage,
    ProjectPatch,
    ResumeCanvas,
    TemplateCreate,
    TemplateOut,
    iso_utc,
)

router = APIRouter()


def _project_to_out(p: Project) -> ProjectOut:
    return ProjectOut(
        id=p.id,
        name=p.name,
        industry=p.industry,
        status=p.status,  # type: ignore[arg-type]
        workspaceId=p.workspace_id,
        createdAt=iso_utc(p.created_at) or "",
        updatedAt=iso_utc(p.updated_at) or "",
        revision=int(p.revision),
    )


def _canvas_to_summary(db: Session, ctx: AuthContext, c: CanvasRecord) -> CanvasSummary:
    eff_role, _, _ = get_effective_project_permissions(db, ctx, c.project_id)
    return CanvasSummary(
        id=c.id,
        projectId=c.project_id,
        name=c.name,
        revision=int(c.revision),
        nodeCount=int(c.node_count),
        coverAssetId=c.cover_asset_id,
        canEdit=(eff_role in ("owner", "editor")),
        updatedAt=iso_utc(c.updated_at) or "",
        status=c.status,  # type: ignore[arg-type]
    )


def _canvas_to_out(db: Session, ctx: AuthContext, c: CanvasRecord) -> CanvasOut:
    return CanvasOut(
        summary=_canvas_to_summary(db, ctx, c),
        graph=Graph.model_validate(c.graph),
    )


def _record_canvas_visit(db: Session, ctx: AuthContext, canvas_id: str) -> None:
    visit = db.get(CanvasVisit, (ctx.user_id, ctx.workspace_id, canvas_id))
    now = utcnow()
    if not visit:
        visit = CanvasVisit(
            user_id=ctx.user_id,
            workspace_id=ctx.workspace_id,
            canvas_id=canvas_id,
            seen_at=now,
        )
        db.add(visit)
    else:
        visit.seen_at = now


def validate_and_extract_graph_refs(
    db: Session,
    ctx: AuthContext,
    project_id: str,
    graph: Graph,
) -> tuple[list[tuple[str, str]], str | None]:
    """
    Validates node uniqueness, node count limits, frame parent chains (no cycles),
    edge endpoint existence, duplicate edges, DAG cycle detection, and workspace asset/subject ownership.
    Returns (list of (node_id, asset_id) pairs, cover_asset_id).
    """
    billing_state = build_billing_state(db, ctx.workspace_id)
    node_limit = billing_state.entitlements.canvasNodeLimit
    if len(graph.nodes) > node_limit:
        raise AppError(
            413,
            "PAYLOAD_TOO_LARGE",
            f"画布节点数量 {len(graph.nodes)} 超过当前权益上限 {node_limit}",
        )

    node_map = {}
    for n in graph.nodes:
        if n.id in node_map:
            raise AppError(422, "INVALID_GRAPH", f"节点 ID 重复: {n.id}", details={"nodeId": n.id})
        node_map[n.id] = n

    # Check frame parentId references and cycles
    for n in graph.nodes:
        if n.parentId is not None:
            parent = node_map.get(n.parentId)
            if not parent or parent.type != "frame":
                raise AppError(
                    422,
                    "INVALID_GRAPH",
                    f"节点 {n.id} 的 parentId {n.parentId} 未指向本图有效的 frame 节点",
                    details={"nodeId": n.id, "parentId": n.parentId},
                )
            seen_parents = {n.id}
            curr = parent
            while curr is not None:
                if curr.id in seen_parents:
                    raise AppError(
                        422,
                        "INVALID_GRAPH",
                        f"Frame 嵌套存在环路: {curr.id}",
                        details={"nodeId": curr.id},
                    )
                seen_parents.add(curr.id)
                curr = node_map.get(curr.parentId) if curr.parentId else None

    # Check edges & DAG cycle detection
    adj: dict[str, list[str]] = {nid: [] for nid in node_map}
    seen_edges: set[tuple[str, str, str, int]] = set()
    edge_ids: set[str] = set()
    for e in graph.edges:
        if e.id in edge_ids:
            raise AppError(422, "INVALID_GRAPH", f"边 ID 重复: {e.id}", details={"edgeId": e.id})
        edge_ids.add(e.id)
        if e.source not in node_map or e.target not in node_map:
            raise AppError(
                422,
                "INVALID_GRAPH",
                f"边 {e.id} 引用了不存在的节点 ({e.source} -> {e.target})",
                details={"edgeId": e.id, "source": e.source, "target": e.target},
            )
        if e.source == e.target:
            raise AppError(422, "INVALID_GRAPH", f"节点 {e.source} 不能形成自环", details={"nodeId": e.source})
        sig = (e.source, e.target, e.role, int(e.ordinal or 0))
        if sig in seen_edges:
            raise AppError(422, "INVALID_GRAPH", f"重复的连接边: {e.id}", details={"edgeId": e.id})
        seen_edges.add(sig)
        adj[e.source].append(e.target)

    # DFS cycle check
    visit_state: dict[str, int] = {nid: 0 for nid in node_map}  # 0=unvisited, 1=visiting, 2=done

    def _has_cycle(u: str) -> bool:
        visit_state[u] = 1
        for v in adj[u]:
            if visit_state[v] == 1:
                return True
            if visit_state[v] == 0 and _has_cycle(v):
                return True
        visit_state[u] = 2
        return False

    for nid in node_map:
        if visit_state[nid] == 0 and _has_cycle(nid):
            raise AppError(422, "INVALID_GRAPH", "画布有向图存在环路 (DAG 校验失败)")

    # Validate asset & subject references belong to current workspace
    asset_refs: list[tuple[str, str]] = []
    cover_asset_id: str | None = None
    for n in graph.nodes:
        if n.type == "asset" and n.assetId:
            asset = db.scalar(
                select(AssetRecord).where(
                    AssetRecord.id == n.assetId,
                    AssetRecord.workspace_id == ctx.workspace_id,
                )
            )
            if not asset:
                raise AppError(
                    404,
                    "NOT_FOUND",
                    f"画布节点 {n.id} 引用的素材 {n.assetId} 不存在或无权访问",
                    details={"nodeId": n.id, "assetId": n.assetId},
                )
            asset_refs.append((n.id, asset.id))
            if cover_asset_id is None and asset.media_kind == "image":
                cover_asset_id = asset.id
        elif n.type == "subject" and n.subjectId:
            subj = db.scalar(
                select(SubjectRecord).where(
                    SubjectRecord.id == n.subjectId,
                    SubjectRecord.workspace_id == ctx.workspace_id,
                )
            )
            if not subj:
                raise AppError(
                    404,
                    "NOT_FOUND",
                    f"画布节点 {n.id} 引用的商品主体 {n.subjectId} 不存在或无权访问",
                    details={"nodeId": n.id, "subjectId": n.subjectId},
                )

    return asset_refs, cover_asset_id


@router.get("/projects", response_model=ProjectPage)
def list_projects(
    q: str | None = Query(default=None, max_length=128),
    industry: str | None = Query(default=None),
    status: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> ProjectPage:
    stmt = select(Project).where(Project.workspace_id == ctx.workspace_id)
    if industry:
        stmt = stmt.where(Project.industry == industry)
    if status:
        stmt = stmt.where(Project.status == status)
    stmt = stmt.order_by(Project.updated_at.desc(), Project.id.desc())
    rows = list(db.scalars(stmt).all())
    if q:
        rows = [r for r in rows if q.lower() in r.name.lower()]

    start_idx = 0
    if cursor:
        for idx, r in enumerate(rows):
            if r.id == cursor:
                start_idx = idx + 1
                break
    page = rows[start_idx : start_idx + limit]
    next_cursor = page[-1].id if len(rows) > start_idx + limit and page else None
    return ProjectPage(items=[_project_to_out(p) for p in page], nextCursor=next_cursor)


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(
    body: ProjectCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> ProjectOut:
    if ctx.role == "viewer":
        raise AppError(403, "READ_ONLY", "只读成员无权创建项目")
    now = utcnow()
    prj = Project(
        id=f"prj-{uuid.uuid4().hex[:12]}",
        workspace_id=ctx.workspace_id,
        name=body.name.strip(),
        industry=body.industry.strip(),
        status="active",
        revision=1,
        created_by=ctx.user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(prj)
    db.commit()
    return _project_to_out(prj)


@router.patch("/projects/{projectId}", response_model=ProjectOut)
def update_project(
    projectId: str,
    body: ProjectPatch,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> ProjectOut:
    prj = require_project_access(db, ctx, projectId, write=True)
    if prj.revision != body.baseRevision:
        raise AppError(
            409,
            "PROJECT_CONFLICT",
            f"项目版本冲突：期望基线 {body.baseRevision}，当前版本 {prj.revision}",
            details={"currentRevision": prj.revision, "projectId": prj.id},
        )
    if body.name is not None:
        prj.name = body.name.strip()
    if body.status is not None:
        prj.status = body.status
    prj.revision += 1
    prj.updated_at = utcnow()
    db.commit()
    return _project_to_out(prj)


@router.get("/canvases", response_model=CanvasPage)
def list_canvases(
    project_id: str | None = Query(default=None, alias="projectId"),
    scope: str | None = Query(default=None),
    q: str | None = Query(default=None, max_length=128),
    status: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CanvasPage:
    stmt = select(CanvasRecord).where(CanvasRecord.workspace_id == ctx.workspace_id)
    if project_id:
        stmt = stmt.where(CanvasRecord.project_id == project_id)
    if status:
        stmt = stmt.where(CanvasRecord.status == status)
    stmt = stmt.order_by(CanvasRecord.updated_at.desc(), CanvasRecord.id.desc())
    rows = list(db.scalars(stmt).all())
    if q:
        rows = [r for r in rows if q.lower() in r.name.lower()]
    total = len(rows)

    start_idx = 0
    if cursor:
        for idx, r in enumerate(rows):
            if r.id == cursor:
                start_idx = idx + 1
                break
    page = rows[start_idx : start_idx + limit]
    next_cursor = page[-1].id if len(rows) > start_idx + limit and page else None
    return CanvasPage(
        items=[_canvas_to_summary(db, ctx, c) for c in page],
        nextCursor=next_cursor,
        total=total,
    )


# IMPORTANT: GET /canvases/recent MUST be registered before GET /canvases/{canvasId}
@router.get("/canvases/recent", response_model=ResumeCanvas)
def resume_canvas(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> ResumeCanvas:
    row = db.execute(
        select(CanvasRecord)
        .join(CanvasVisit, CanvasVisit.canvas_id == CanvasRecord.id)
        .where(
            CanvasVisit.user_id == ctx.user_id,
            CanvasVisit.workspace_id == ctx.workspace_id,
            CanvasRecord.workspace_id == ctx.workspace_id,
        )
        .order_by(CanvasVisit.seen_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if not row:
        return ResumeCanvas(canvas=None)
    return ResumeCanvas(canvas=_canvas_to_summary(db, ctx, row))


@router.post("/projects/{projectId}/canvases", response_model=CanvasOut, status_code=201)
def create_canvas(
    projectId: str,
    body: CanvasCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CanvasOut:
    require_project_access(db, ctx, projectId, write=True)
    default_graph: dict[str, Any] = {
        "schemaVersion": 1,
        "viewport": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "nodes": [],
        "edges": [],
    }
    if body.templateId:
        tpl = db.scalar(
            select(TemplateRecord)
            .where(
                TemplateRecord.id == body.templateId,
                (TemplateRecord.scope == "official") | (TemplateRecord.workspace_id == ctx.workspace_id),
            )
            .order_by(TemplateRecord.version.desc())
        )
        if not tpl:
            raise AppError(404, "NOT_FOUND", f"模板 {body.templateId} 不存在")
        if tpl.graph and isinstance(tpl.graph, dict) and "schemaVersion" in tpl.graph:
            default_graph = copy.deepcopy(tpl.graph)

    parsed_graph = Graph.model_validate(default_graph)
    asset_refs, cover_asset_id = validate_and_extract_graph_refs(db, ctx, projectId, parsed_graph)
    now = utcnow()
    canvas = CanvasRecord(
        id=f"cvs-{uuid.uuid4().hex[:12]}",
        workspace_id=ctx.workspace_id,
        project_id=projectId,
        name=body.name.strip(),
        status="active",
        revision=1,
        schema_version=1,
        graph=parsed_graph.model_dump(exclude_none=True),
        node_count=len(parsed_graph.nodes),
        cover_asset_id=cover_asset_id,
        created_by=ctx.user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(canvas)
    db.flush()

    for node_id, asset_id in set(asset_refs):
        db.add(
            CanvasAssetRef(
                canvas_id=canvas.id,
                node_id=node_id,
                asset_id=asset_id,
                workspace_id=ctx.workspace_id,
                project_id=projectId,
            )
        )
    _record_canvas_visit(db, ctx, canvas.id)
    db.commit()
    return _canvas_to_out(db, ctx, canvas)


@router.get("/canvases/{canvasId}", response_model=CanvasOut)
def read_canvas(
    canvasId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CanvasOut:
    canvas = db.scalar(
        select(CanvasRecord).where(
            CanvasRecord.id == canvasId,
            CanvasRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not canvas:
        raise AppError(404, "NOT_FOUND", "画布不存在或无权访问")
    _record_canvas_visit(db, ctx, canvas.id)
    db.commit()
    return _canvas_to_out(db, ctx, canvas)


@router.put("/canvases/{canvasId}", response_model=CanvasOut)
def save_canvas(
    canvasId: str,
    body: CanvasSave,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CanvasOut:
    canvas = db.scalar(
        select(CanvasRecord).where(
            CanvasRecord.id == canvasId,
            CanvasRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not canvas:
        raise AppError(404, "NOT_FOUND", "画布不存在或无权访问")
    require_project_access(db, ctx, canvas.project_id, write=True)

    asset_refs, cover_asset_id = validate_and_extract_graph_refs(db, ctx, canvas.project_id, body.graph)
    now = utcnow()
    new_name = body.name.strip() if body.name is not None else canvas.name
    new_status = body.status if body.status is not None else canvas.status
    graph_json = body.graph.model_dump(exclude_none=True)

    # Atomic compare-and-swap on (id, workspace_id, revision)
    stmt = (
        update(CanvasRecord)
        .where(
            CanvasRecord.id == canvasId,
            CanvasRecord.workspace_id == ctx.workspace_id,
            CanvasRecord.revision == body.baseRevision,
        )
        .values(
            name=new_name,
            status=new_status,
            revision=body.baseRevision + 1,
            graph=graph_json,
            node_count=len(body.graph.nodes),
            cover_asset_id=cover_asset_id,
            updated_at=now,
        )
    )
    res = db.execute(stmt)
    if res.rowcount == 0:
        db.expire(canvas)
        current = db.get(CanvasRecord, canvasId)
        curr_rev = int(current.revision) if current else None
        raise AppError(
            409,
            "CANVAS_CONFLICT",
            f"画布基线版本落后：提交的 baseRevision={body.baseRevision}，服务端当前版本={curr_rev}",
            details={"canvasId": canvasId, "baseRevision": body.baseRevision, "currentRevision": curr_rev},
        )

    db.execute(delete(CanvasAssetRef).where(CanvasAssetRef.canvas_id == canvasId))
    for node_id, asset_id in set(asset_refs):
        db.add(
            CanvasAssetRef(
                canvas_id=canvasId,
                node_id=node_id,
                asset_id=asset_id,
                workspace_id=ctx.workspace_id,
                project_id=canvas.project_id,
            )
        )
    _record_canvas_visit(db, ctx, canvasId)
    db.commit()
    db.expire(canvas)
    updated_canvas = db.get(CanvasRecord, canvasId)
    assert updated_canvas is not None
    return _canvas_to_out(db, ctx, updated_canvas)


@router.post("/canvases/{canvasId}/clone", response_model=CanvasOut, status_code=201)
def clone_canvas(
    canvasId: str,
    body: CloneCanvas,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CanvasOut:
    source = db.scalar(
        select(CanvasRecord).where(
            CanvasRecord.id == canvasId,
            CanvasRecord.workspace_id == ctx.workspace_id,
        )
    )
    if not source:
        raise AppError(404, "NOT_FOUND", "源画布不存在或无权访问")
    _, allow_copy, _ = get_effective_project_permissions(db, ctx, source.project_id)
    if not allow_copy:
        raise AppError(403, "READ_ONLY", "当前画布未被授予复制权限")

    target_prj = require_project_access(db, ctx, body.targetProjectId, write=True)
    graph_copy = Graph.model_validate(copy.deepcopy(source.graph))
    asset_refs, cover_asset_id = validate_and_extract_graph_refs(db, ctx, target_prj.id, graph_copy)

    now = utcnow()
    clone_name = body.name.strip() if body.name else f"{source.name} (副本)"
    cloned = CanvasRecord(
        id=f"cvs-{uuid.uuid4().hex[:12]}",
        workspace_id=ctx.workspace_id,
        project_id=target_prj.id,
        name=clone_name,
        status="active",
        revision=1,
        schema_version=1,
        graph=graph_copy.model_dump(exclude_none=True),
        node_count=len(graph_copy.nodes),
        cover_asset_id=cover_asset_id,
        created_by=ctx.user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(cloned)
    db.flush()
    for node_id, asset_id in set(asset_refs):
        db.add(
            CanvasAssetRef(
                canvas_id=cloned.id,
                node_id=node_id,
                asset_id=asset_id,
                workspace_id=ctx.workspace_id,
                project_id=target_prj.id,
            )
        )
    _record_canvas_visit(db, ctx, cloned.id)
    db.commit()
    return _canvas_to_out(db, ctx, cloned)


@router.post("/canvases/{canvasId}/templates", response_model=TemplateOut, status_code=201)
def save_template(
    canvasId: str,
    body: TemplateCreate,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> TemplateOut:
    settings = get_settings()
    if body.visibility == "team" and not settings.feature_org_collaboration:
        raise AppError(404, "FEATURE_DISABLED", "团队模板功能 (org_collaboration) 在当前版本未启用")

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
            f"画布版本不匹配：期望 baseRevision={body.baseRevision}，实际={canvas.revision}",
            details={"currentRevision": canvas.revision},
        )

    # Sanitize private merchant assets/subjects into typed placeholder nodes
    raw_graph = copy.deepcopy(canvas.graph)
    suggested_modes: list[str] = []
    first_prompt = ""
    first_aspect = "1:1"
    sanitized_nodes = []
    for node in raw_graph.get("nodes", []):
        ntype = node.get("type")
        if ntype == "asset":
            sanitized_nodes.append(
                {
                    "id": node["id"],
                    "type": "placeholder",
                    "position": node["position"],
                    "expectedKind": "image",
                    "label": node.get("label") or "素材占位",
                }
            )
        elif ntype == "subject":
            sanitized_nodes.append(
                {
                    "id": node["id"],
                    "type": "placeholder",
                    "position": node["position"],
                    "expectedKind": "subject",
                    "label": node.get("label") or "商品主体占位",
                }
            )
        else:
            node_copy = copy.deepcopy(node)
            node_copy.pop("jobId", None)
            if ntype == "generation":
                mode = node_copy.get("mode")
                if mode and mode not in suggested_modes:
                    suggested_modes.append(mode)
                cfg = node_copy.get("config") or {}
                if not first_prompt and cfg.get("prompt"):
                    first_prompt = cfg["prompt"]
                params = cfg.get("parameters") or {}
                if params.get("aspectRatio"):
                    first_aspect = params["aspectRatio"]
            sanitized_nodes.append(node_copy)
    raw_graph["nodes"] = sanitized_nodes

    tpl = TemplateRecord(
        id=f"tpl-{uuid.uuid4().hex[:12]}",
        version=1,
        scope=body.visibility,
        workspace_id=ctx.workspace_id,
        name=body.name.strip(),
        industry=body.industry.strip(),
        prompt=first_prompt,
        suggested_modes=suggested_modes or ["product_scene"],
        aspect_ratio=first_aspect,
        tags=list(body.tags),
        graph=raw_graph,
        created_at=utcnow(),
    )
    db.add(tpl)
    db.commit()
    return TemplateOut(
        id=tpl.id,
        version=1,
        name=tpl.name,
        industry=tpl.industry,
        prompt=tpl.prompt,
        suggestedModes=tpl.suggested_modes,  # type: ignore[arg-type]
        aspectRatio=tpl.aspect_ratio,
        tags=tpl.tags,
        visibility=tpl.scope,  # type: ignore[arg-type]
    )
