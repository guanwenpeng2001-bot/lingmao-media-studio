from __future__ import annotations

import copy
import uuid
from datetime import timedelta
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.billing.ledger import (
    capture_reservation_for_job,
    lock_workspace_usage,
    release_reservation_for_job,
)
from app.config import get_settings
from app.models import (
    AssetInputRecord,
    AssetRecord,
    JobEventRecord,
    JobRecord,
    ProviderDispatchRecord,
    QuoteItemRecord,
    ReservationRecord,
    RunRecord,
    RunStepRecord,
    Workspace,
    utcnow,
)
from app.providers.generation import MaterializedOutput
from app.schemas import JobOut, iso_utc


def append_job_event(db: Session, workspace_id: str, job: JobRecord) -> JobEventRecord:
    ws = db.scalar(
        select(Workspace).where(Workspace.id == workspace_id).with_for_update()
    )
    assert ws is not None
    ws.event_cursor = int(ws.event_cursor) + 1
    evt = JobEventRecord(
        workspace_id=workspace_id,
        seq=int(ws.event_cursor),
        job_id=job.id,
        revision=int(job.revision),
        status=job.state,
        at=utcnow(),
    )
    db.add(evt)
    db.flush()
    return evt


def build_job_out(db: Session, job: JobRecord) -> JobOut:
    res = db.scalar(select(ReservationRecord).where(ReservationRecord.job_id == job.id))
    q_item = db.get(QuoteItemRecord, job.quote_item_id)
    expected_credits = int(q_item.cost) if q_item else (int(res.amount) if res else 0)
    if res:
        charging = res.state
        reserved_credits = int(res.amount) if res.state == "held" else 0
        charged_credits = int(res.actual) if res.state == "captured" else 0
    else:
        charging = "released" if job.state in ("failed", "cancelled") else "captured"
        reserved_credits = 0
        charged_credits = expected_credits if job.state == "succeeded" else 0

    clean_input = copy.deepcopy(job.frozen_input or {})
    clean_input.pop("_frozenMeta", None)

    return JobOut(
        id=job.id,
        projectId=job.project_id,
        canvasId=job.canvas_id,
        nodeId=job.node_id,
        status=job.state,  # type: ignore[arg-type]
        input=clean_input,
        retryOfJobId=job.retry_of_job_id,
        outputAssetIds=list(job.result_refs or []),
        progress=job.progress,
        reservedCredits=reserved_credits,
        chargedCredits=charged_credits,
        errorCode=job.error_code,
        retryable=(job.state in ("failed", "cancelled")),
        createdAt=iso_utc(job.created_at) or "",
        updatedAt=iso_utc(job.updated_at) or "",
        batchId=job.batch_id,
        cancelRequested=bool(job.cancel_requested),
        revision=int(job.revision),
        charging=charging,  # type: ignore[arg-type]
        expectedCredits=expected_credits,
    )


def _sync_run_state(db: Session, run_id: str) -> None:
    run = db.scalar(select(RunRecord).where(RunRecord.id == run_id).with_for_update())
    if not run:
        return
    steps = list(
        db.scalars(
            select(RunStepRecord)
            .where(RunStepRecord.run_id == run_id)
            .order_by(RunStepRecord.id.asc())
            .with_for_update()
        ).all()
    )
    if not steps:
        return

    # Sync step states with their jobs
    step_by_node: dict[str, RunStepRecord] = {}
    job_by_id: dict[str, JobRecord] = {}
    for s in steps:
        if s.node_id:
            step_by_node[s.node_id] = s
        if s.job_id:
            j = db.get(JobRecord, s.job_id)
            if j:
                job_by_id[j.id] = j
                s.state = j.state

    # For graph runs, check if waiting steps can now be queued or must be skipped
    if run.kind == "graph":
        settings = get_settings()
        usage = lock_workspace_usage(db, run.workspace_id)
        provider_name = "demo-deterministic" if settings.is_demo_inference else "live-provider"
        now = utcnow()
        changed = True
        while changed:
            changed = False
            for s in steps:
                if s.state != "waiting":
                    continue
                deps = [step_by_node[d] for d in (s.depends_on or []) if d in step_by_node]
                if any(d.state in ("failed", "cancelled", "skipped") for d in deps):
                    s.state = "skipped"
                    release_reservation_for_job(db, job_id="", quote_item_id=s.quote_item_id)
                    changed = True
                elif all(d.state == "succeeded" for d in deps):
                    # Create runnable job for this downstream graph step
                    frozen_in = copy.deepcopy(s.input_bindings)
                    upstream_assets: list[str] = []
                    for d in deps:
                        if d.job_id and d.job_id in job_by_id:
                            upstream_assets.extend(job_by_id[d.job_id].result_refs or [])
                    mode = frozen_in.get("mode", "product_scene")
                    if mode not in ("text_to_image", "text_to_video") and not frozen_in.get("inputAssetIds") and upstream_assets:
                        frozen_in["inputAssetIds"] = [upstream_assets[0]]

                    new_job = JobRecord(
                        id=f"job-{uuid.uuid4().hex[:14]}",
                        workspace_id=run.workspace_id,
                        project_id=run.project_id,
                        quote_item_id=s.quote_item_id,
                        run_id=run.id,
                        batch_id=None,
                        canvas_id=run.canvas_id,
                        node_id=s.node_id,
                        retry_of_job_id=None,
                        state="queued",
                        revision=1,
                        frozen_input=frozen_in,
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
                    db.add(new_job)
                    db.flush()

                    res = db.scalar(
                        select(ReservationRecord)
                        .where(ReservationRecord.quote_item_id == s.quote_item_id)
                        .with_for_update()
                    )
                    if res:
                        res.job_id = new_job.id

                    disp = ProviderDispatchRecord(
                        id=f"dsp-{uuid.uuid4().hex[:14]}",
                        workspace_id=run.workspace_id,
                        job_id=new_job.id,
                        provider=provider_name,
                        dispatch_key=f"disp:{new_job.id}:1",
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
                    s.job_id = new_job.id
                    s.state = "queued"
                    job_by_id[new_job.id] = new_job
                    usage.queued_jobs += 1
                    append_job_event(db, run.workspace_id, new_job)
                    changed = True

    states = [s.state for s in steps]
    if any(st in ("waiting", "queued", "running") for st in states):
        run.status = "running"
    elif all(st == "succeeded" for st in states):
        run.status = "succeeded"
    elif any(st == "succeeded" for st in states):
        run.status = "partial"
    elif all(st == "cancelled" for st in states):
        run.status = "cancelled"
    else:
        run.status = "failed"
    run.updated_at = utcnow()
    db.flush()


def transition_job_to_running(
    db: Session,
    job_id: str,
    provider_job_id: str | None = None,
    progress: int | None = 25,
) -> JobRecord | None:
    job = db.scalar(select(JobRecord).where(JobRecord.id == job_id).with_for_update())
    if not job:
        return None
    # Out-of-order guard: never revert terminal job back to running!
    if job.state in ("succeeded", "failed", "cancelled"):
        return job

    usage = lock_workspace_usage(db, job.workspace_id)
    disp = db.scalar(
        select(ProviderDispatchRecord)
        .where(ProviderDispatchRecord.job_id == job.id)
        .order_by(ProviderDispatchRecord.attempt.desc())
        .with_for_update()
    )
    now = utcnow()
    if disp and provider_job_id and not disp.provider_job_id:
        disp.provider_job_id = provider_job_id

    if job.state == "queued":
        job.state = "running"
        job.revision += 1
        job.progress = progress if progress is not None else 20
        job.updated_at = now
        if usage.queued_jobs > 0:
            usage.queued_jobs -= 1
        usage.active_jobs += 1
        usage.version += 1
        append_job_event(db, job.workspace_id, job)
        if job.run_id:
            _sync_run_state(db, job.run_id)
    elif job.state == "running" and progress is not None and (job.progress or 0) < progress:
        job.progress = progress
        job.updated_at = now

    db.flush()
    return job


def settle_job_succeeded(
    db: Session,
    job_id: str,
    output: MaterializedOutput,
    expected_lease_epoch: int | None = None,
) -> JobRecord:
    job = db.scalar(select(JobRecord).where(JobRecord.id == job_id).with_for_update())
    if not job:
        raise ValueError(f"Job {job_id} not found")

    usage = lock_workspace_usage(db, job.workspace_id)
    disp = db.scalar(
        select(ProviderDispatchRecord)
        .where(ProviderDispatchRecord.job_id == job.id)
        .order_by(ProviderDispatchRecord.attempt.desc())
        .with_for_update()
    )

    if expected_lease_epoch is not None and disp is not None and disp.lease_epoch != expected_lease_epoch:
        return job

    # Idempotent Terminal CAS: if already terminal, do not double-settle or flip failed/cancelled to succeeded!
    if job.state in ("succeeded", "failed", "cancelled"):
        return job

    # If user requested cancellation before settlement, honor cancellation and release credits
    if job.cancel_requested:
        return settle_job_terminal_failure_or_cancel(
            db, job_id=job.id, target_state="cancelled", error_code=None
        )

    prev_state = job.state
    now = utcnow()

    # Deduplicated output asset creation via UNIQUE(source_job_id, output_index)
    existing_asset = db.scalar(
        select(AssetRecord).where(
            AssetRecord.source_job_id == job.id,
            AssetRecord.output_index == 0,
        )
    )
    if existing_asset is None:
        mode = str((job.frozen_input or {}).get("mode", "product_scene"))
        ext = "mp4" if output.media_kind == "video" else "png"
        asset_id = f"ast-{uuid.uuid4().hex[:14]}"
        existing_asset = AssetRecord(
            id=asset_id,
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            name=f"{mode}_{job.id[-8:]}.{ext}",
            media_kind=output.media_kind,
            asset_role=output.asset_role,
            origin="generated",
            state="ready",
            source_job_id=job.id,
            output_index=0,
            object_key=output.object_key,
            sha256=output.sha256,
            content_type=output.content_type,
            byte_size=output.byte_size,
            width=output.width,
            height=output.height,
            duration_ms=output.duration_ms,
            metadata_json=output.metadata,
            tags=[mode, output.execution_mode],
            archived_at=None,
            purge_after=None,
            created_at=now,
        )
        db.add(existing_asset)
        db.flush()

        # Record input asset lineage in asset_inputs
        frozen_in = job.frozen_input or {}
        in_asset_ids: list[str] = list(frozen_in.get("inputAssetIds") or [])
        for idx, in_id in enumerate(in_asset_ids):
            role = "first_frame" if (output.media_kind == "video" and idx == 0) else "reference"
            db.add(
                AssetInputRecord(
                    output_asset_id=existing_asset.id,
                    input_asset_id=in_id,
                    role=role,
                    ordinal=idx,
                )
            )
        params = frozen_in.get("parameters") or {}
        mask_id = params.get("maskAssetId") or (frozen_in.get("_frozenMeta") or {}).get("resolvedMaskAssetId")
        if mask_id:
            db.add(
                AssetInputRecord(
                    output_asset_id=existing_asset.id,
                    input_asset_id=mask_id,
                    role="mask",
                    ordinal=0,
                )
            )
        last_frame_id = params.get("lastFrameAssetId")
        if last_frame_id:
            db.add(
                AssetInputRecord(
                    output_asset_id=existing_asset.id,
                    input_asset_id=last_frame_id,
                    role="last_frame",
                    ordinal=1,
                )
            )

        usage.used_bytes += output.byte_size

    # Settle reservation: held -> captured (spent)
    capture_reservation_for_job(db, job.id)

    job.state = "succeeded"
    job.revision += 1
    job.result_refs = [existing_asset.id]
    job.progress = 100
    job.error_code = None
    job.updated_at = now

    if disp:
        disp.state = "completed"
        if output.provider_job_id and not disp.provider_job_id:
            disp.provider_job_id = output.provider_job_id
        disp.lease_until = None

    if prev_state == "running" and usage.active_jobs > 0:
        usage.active_jobs -= 1
    elif prev_state == "queued" and usage.queued_jobs > 0:
        usage.queued_jobs -= 1
    usage.version += 1

    append_job_event(db, job.workspace_id, job)
    if job.run_id:
        _sync_run_state(db, job.run_id)

    db.flush()
    return job


def settle_job_terminal_failure_or_cancel(
    db: Session,
    job_id: str,
    target_state: str,  # "failed" | "cancelled"
    error_code: str | None = None,
    expected_lease_epoch: int | None = None,
) -> JobRecord:
    assert target_state in ("failed", "cancelled")
    job = db.scalar(select(JobRecord).where(JobRecord.id == job_id).with_for_update())
    if not job:
        raise ValueError(f"Job {job_id} not found")

    usage = lock_workspace_usage(db, job.workspace_id)
    disp = db.scalar(
        select(ProviderDispatchRecord)
        .where(ProviderDispatchRecord.job_id == job.id)
        .order_by(ProviderDispatchRecord.attempt.desc())
        .with_for_update()
    )

    if expected_lease_epoch is not None and disp is not None and disp.lease_epoch != expected_lease_epoch:
        return job

    # Idempotent Terminal CAS
    if job.state in ("succeeded", "failed", "cancelled"):
        return job

    prev_state = job.state
    now = utcnow()

    # Release reservation: held -> available
    release_reservation_for_job(db, job.id)

    job.state = target_state
    job.revision += 1
    job.error_code = error_code if target_state == "failed" else None
    job.updated_at = now

    if disp:
        disp.state = target_state
        disp.lease_until = None
        if error_code:
            disp.last_error = error_code

    if prev_state == "running" and usage.active_jobs > 0:
        usage.active_jobs -= 1
    elif prev_state == "queued" and usage.queued_jobs > 0:
        usage.queued_jobs -= 1
    usage.version += 1

    append_job_event(db, job.workspace_id, job)
    if job.run_id:
        _sync_run_state(db, job.run_id)

    db.flush()
    return job
