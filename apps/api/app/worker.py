from __future__ import annotations

import argparse
import logging
import os
import socket
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from sqlalchemy import select
from app.config import get_settings
from app.db import get_session_factory
from app.jobs.settlement import (
    settle_job_succeeded,
    settle_job_terminal_failure_or_cancel,
    transition_job_to_running,
)
from app.models import (
    AssetRecord,
    JobRecord,
    ProviderDispatchRecord,
    utcnow,
)
from app.providers.generation import DeterministicDemoGenerationAdapter

logger = logging.getLogger("lingmao.worker")


@dataclass
class ClaimedTask:
    dispatch_id: str
    job_id: str
    workspace_id: str
    project_id: str
    dispatch_key: str
    lease_epoch: int
    frozen_input: dict[str, Any]
    input_assets: list[dict[str, Any]]
    mask_asset: dict[str, Any] | None


def claim_next_dispatch(worker_id: str) -> ClaimedTask | None:
    settings = get_settings()
    session_factory = get_session_factory()
    now = utcnow()
    lease_until = now + timedelta(seconds=int(settings.worker_lease_seconds))

    with session_factory() as db:
        disp = db.scalar(
            select(ProviderDispatchRecord)
            .join(JobRecord, JobRecord.id == ProviderDispatchRecord.job_id)
            .where(
                JobRecord.state.in_(["queued", "running"]),
                ProviderDispatchRecord.state.in_(["queued", "submitted", "polling"]),
                ProviderDispatchRecord.next_poll_at <= now,
                (ProviderDispatchRecord.lease_until.is_(None))
                | (ProviderDispatchRecord.lease_until <= now),
            )
            .order_by(JobRecord.priority.desc(), JobRecord.created_at.asc())
            .limit(1)
            .with_for_update(of=ProviderDispatchRecord, skip_locked=True)
        )
        if disp is None:
            return None

        job = db.scalar(select(JobRecord).where(JobRecord.id == disp.job_id).with_for_update())
        if job is None or job.state in ("succeeded", "failed", "cancelled"):
            disp.state = "completed" if (job and job.state == "succeeded") else "cancelled"
            disp.lease_until = None
            db.commit()
            return None

        if job.cancel_requested:
            settle_job_terminal_failure_or_cancel(db, job.id, target_state="cancelled", error_code=None)
            db.commit()
            return None

        if job.deadline_at <= now:
            settle_job_terminal_failure_or_cancel(
                db, job.id, target_state="failed", error_code="JOB_TIMEOUT"
            )
            db.commit()
            return None

        disp.lease_owner = worker_id
        disp.lease_until = lease_until
        disp.lease_epoch = int(disp.lease_epoch) + 1
        disp.state = "polling"
        epoch = int(disp.lease_epoch)

        transition_job_to_running(db, job.id, progress=35)

        frozen_in = dict(job.frozen_input or {})
        input_assets: list[dict[str, Any]] = []
        for aid in frozen_in.get("inputAssetIds") or []:
            a = db.get(AssetRecord, aid)
            if a:
                input_assets.append(
                    {
                        "id": a.id,
                        "object_key": a.object_key,
                        "sha256": a.sha256,
                        "width": a.width,
                        "height": a.height,
                    }
                )

        mask_asset = None
        params = frozen_in.get("parameters") or {}
        mask_id = params.get("maskAssetId") or (frozen_in.get("_frozenMeta") or {}).get("resolvedMaskAssetId")
        if mask_id:
            ma = db.get(AssetRecord, mask_id)
            if ma:
                mask_asset = {"id": ma.id, "object_key": ma.object_key, "sha256": ma.sha256}

        claimed = ClaimedTask(
            dispatch_id=disp.id,
            job_id=job.id,
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            dispatch_key=disp.dispatch_key,
            lease_epoch=epoch,
            frozen_input=frozen_in,
            input_assets=input_assets,
            mask_asset=mask_asset,
        )
        db.commit()
        return claimed


def process_claimed_task(claimed: ClaimedTask) -> str:
    adapter = DeterministicDemoGenerationAdapter()
    session_factory = get_session_factory()

    try:
        materialized = adapter.materialize(
            workspace_id=claimed.workspace_id,
            project_id=claimed.project_id,
            job_id=claimed.job_id,
            dispatch_key=claimed.dispatch_key,
            frozen_input=claimed.frozen_input,
            input_assets=claimed.input_assets,
            mask_asset=claimed.mask_asset,
        )
    except Exception as exc:
        err_code = "PROVIDER_UNAVAILABLE" if "PROVIDER_UNAVAILABLE" in str(exc) else "GENERATION_FAILED"
        with session_factory() as db:
            settle_job_terminal_failure_or_cancel(
                db,
                job_id=claimed.job_id,
                target_state="failed",
                error_code=err_code,
                expected_lease_epoch=claimed.lease_epoch,
            )
            db.commit()
        return "failed"

    with session_factory() as db:
        job = settle_job_succeeded(
            db,
            job_id=claimed.job_id,
            output=materialized,
            expected_lease_epoch=claimed.lease_epoch,
        )
        final_state = job.state
        db.commit()
    return final_state


def run_worker_step(worker_id: str = "worker-main") -> bool:
    claimed = claim_next_dispatch(worker_id)
    if claimed is None:
        return False
    process_claimed_task(claimed)
    return True


def drain_all_queued(worker_id: str = "worker-drain", max_jobs: int = 100) -> int:
    processed = 0
    while processed < max_jobs:
        if not run_worker_step(worker_id):
            break
        processed += 1
    return processed


def main() -> None:
    parser = argparse.ArgumentParser(description="Lingmao Media Studio persistent job worker")
    parser.add_argument("--once", action="store_true", help="Drain all currently ready jobs and exit")
    parser.add_argument(
        "--worker-id",
        default=f"worker-{socket.gethostname()}-{os.getpid()}",
        help="Unique worker lease owner identifier",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    settings = get_settings()
    logger.info(
        "Starting Lingmao Worker %s (mode=%s, demo_inference=%s)",
        args.worker_id,
        settings.env_mode,
        settings.is_demo_inference,
    )

    if args.once:
        count = drain_all_queued(worker_id=args.worker_id)
        logger.info("Worker drained %d job(s) and exited (--once)", count)
        return

    try:
        while True:
            did_work = run_worker_step(worker_id=args.worker_id)
            if not did_work:
                time.sleep(float(settings.worker_poll_interval_seconds))
    except KeyboardInterrupt:
        logger.info("Worker %s shutting down cleanly", args.worker_id)


if __name__ == "__main__":
    main()
