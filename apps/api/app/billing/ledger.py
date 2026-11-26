from __future__ import annotations

import uuid
from datetime import datetime
from sqlalchemy import case, select
from sqlalchemy.orm import Session
from app.config import get_settings
from app.errors import AppError
from app.models import (
    AllocationRecord,
    CreditLedgerRecord,
    CreditLotRecord,
    ModelCatalogRecord,
    OfferRecord,
    ReservationRecord,
    SubscriptionRecord,
    WorkspaceUsageRecord,
    utcnow,
)
from app.schemas import BillingStateOut, EntitlementsOut, SubscriptionOut, WalletLotOut, iso_utc


def lock_workspace_usage(db: Session, workspace_id: str) -> WorkspaceUsageRecord:
    usage = db.scalar(
        select(WorkspaceUsageRecord)
        .where(WorkspaceUsageRecord.workspace_id == workspace_id)
        .with_for_update()
    )
    if not usage:
        usage = WorkspaceUsageRecord(
            workspace_id=workspace_id,
            active_jobs=0,
            queued_jobs=0,
            used_bytes=0,
            pending_bytes=0,
            version=1,
        )
        db.add(usage)
        db.flush()
    return usage


def grant_credit_lot(
    db: Session,
    workspace_id: str,
    source: str,
    grant_key: str,
    credits: int,
    expires_at: datetime | None = None,
    order_id: str | None = None,
) -> CreditLotRecord:
    existing = db.scalar(
        select(CreditLotRecord).where(
            CreditLotRecord.workspace_id == workspace_id,
            CreditLotRecord.grant_key == grant_key,
        )
    )
    if existing is not None:
        return existing

    now = utcnow()
    lot = CreditLotRecord(
        id=f"lot-{uuid.uuid4().hex[:14]}",
        workspace_id=workspace_id,
        source=source,
        grant_key=grant_key,
        original_credits=credits,
        available=credits,
        held=0,
        spent=0,
        expired=0,
        expires_at=expires_at,
        created_at=now,
    )
    db.add(lot)
    db.flush()

    ledger = CreditLedgerRecord(
        id=f"led-{uuid.uuid4().hex[:14]}",
        workspace_id=workspace_id,
        lot_id=lot.id,
        reservation_id=None,
        job_id=None,
        order_id=order_id,
        event_key=f"grant:{grant_key}",
        kind="grant",
        available_delta=credits,
        held_delta=0,
        spent_delta=0,
        expired_delta=0,
        created_at=now,
    )
    db.add(ledger)
    db.flush()
    return lot


def reserve_credits_for_items(
    db: Session,
    workspace_id: str,
    items: list[tuple[str, int, str | None]],
) -> list[ReservationRecord]:
    """
    Atomically reserves credits across earliest-expiring eligible credit lots.
    items: list of (quote_item_id, cost, job_id).
    Must be called while workspace_usage is locked.
    """
    now = utcnow()
    total_required = sum(cost for _, cost, _ in items)

    # Order by earliest expires_at first (trial / subscription lots before long-term packs), NULLS LAST
    source_priority = case(
        (CreditLotRecord.source == "trial", 0),
        (CreditLotRecord.source == "subscription", 1),
        else_=2,
    )
    lots = list(
        db.scalars(
            select(CreditLotRecord)
            .where(
                CreditLotRecord.workspace_id == workspace_id,
                (CreditLotRecord.expires_at.is_(None)) | (CreditLotRecord.expires_at > now),
                CreditLotRecord.available > 0,
            )
            .order_by(
                CreditLotRecord.expires_at.asc().nulls_last(),
                source_priority.asc(),
                CreditLotRecord.created_at.asc(),
                CreditLotRecord.id.asc(),
            )
            .with_for_update()
        ).all()
    )

    total_available = sum(int(l.available) for l in lots)
    if total_available < total_required:
        raise AppError(
            409,
            "INSUFFICIENT_CREDITS",
            f"当前可用积分不足：需要 {total_required}，可用 {total_available}",
            details={
                "required": total_required,
                "available": total_available,
                "shortfall": total_required - total_available,
            },
        )

    reservations: list[ReservationRecord] = []
    for quote_item_id, cost, job_id in items:
        res = ReservationRecord(
            id=f"res-{uuid.uuid4().hex[:14]}",
            workspace_id=workspace_id,
            quote_item_id=quote_item_id,
            job_id=job_id,
            state="held",
            amount=cost,
            actual=0,
            created_at=now,
        )
        db.add(res)
        db.flush()

        remaining = cost
        for lot in lots:
            if remaining <= 0:
                break
            if lot.available <= 0:
                continue
            take = min(int(lot.available), remaining)
            lot.available -= take
            lot.held += take
            remaining -= take

            alloc = AllocationRecord(
                reservation_id=res.id,
                lot_id=lot.id,
                amount=take,
                captured=0,
                released=0,
            )
            db.add(alloc)

            ledger = CreditLedgerRecord(
                id=f"led-{uuid.uuid4().hex[:14]}",
                workspace_id=workspace_id,
                lot_id=lot.id,
                reservation_id=res.id,
                job_id=job_id,
                order_id=None,
                event_key=f"hold:{res.id}",
                kind="hold",
                available_delta=-take,
                held_delta=take,
                spent_delta=0,
                expired_delta=0,
                created_at=now,
            )
            db.add(ledger)

        assert remaining == 0, "Insufficient credits after check"
        reservations.append(res)

    db.flush()
    return reservations


def capture_reservation_for_job(db: Session, job_id: str) -> ReservationRecord | None:
    res = db.scalar(
        select(ReservationRecord)
        .where(ReservationRecord.job_id == job_id)
        .with_for_update()
    )
    if not res or res.state != "held":
        return res

    now = utcnow()
    allocs = list(
        db.scalars(
            select(AllocationRecord)
            .where(AllocationRecord.reservation_id == res.id)
            .with_for_update()
        ).all()
    )
    for alloc in allocs:
        lot = db.scalar(
            select(CreditLotRecord)
            .where(CreditLotRecord.id == alloc.lot_id)
            .with_for_update()
        )
        assert lot is not None
        to_capture = int(alloc.amount - alloc.captured - alloc.released)
        if to_capture <= 0:
            continue
        lot.held -= to_capture
        lot.spent += to_capture
        alloc.captured += to_capture

        ledger = CreditLedgerRecord(
            id=f"led-{uuid.uuid4().hex[:14]}",
            workspace_id=res.workspace_id,
            lot_id=lot.id,
            reservation_id=res.id,
            job_id=job_id,
            order_id=None,
            event_key=f"capture:{res.id}",
            kind="capture",
            available_delta=0,
            held_delta=-to_capture,
            spent_delta=to_capture,
            expired_delta=0,
            created_at=now,
        )
        db.add(ledger)

    res.state = "captured"
    res.actual = res.amount
    db.flush()
    return res


def release_reservation_for_job(db: Session, job_id: str, quote_item_id: str | None = None) -> ReservationRecord | None:
    stmt = select(ReservationRecord)
    if quote_item_id:
        stmt = stmt.where(ReservationRecord.quote_item_id == quote_item_id)
    else:
        stmt = stmt.where(ReservationRecord.job_id == job_id)
    res = db.scalar(stmt.with_for_update())
    if not res or res.state != "held":
        return res

    now = utcnow()
    allocs = list(
        db.scalars(
            select(AllocationRecord)
            .where(AllocationRecord.reservation_id == res.id)
            .with_for_update()
        ).all()
    )
    for alloc in allocs:
        lot = db.scalar(
            select(CreditLotRecord)
            .where(CreditLotRecord.id == alloc.lot_id)
            .with_for_update()
        )
        assert lot is not None
        to_release = int(alloc.amount - alloc.captured - alloc.released)
        if to_release <= 0:
            continue
        lot.held -= to_release
        lot.available += to_release
        alloc.released += to_release

        db.add(
            CreditLedgerRecord(
                id=f"led-{uuid.uuid4().hex[:14]}",
                workspace_id=res.workspace_id,
                lot_id=lot.id,
                reservation_id=res.id,
                job_id=res.job_id,
                order_id=None,
                event_key=f"release:{res.id}",
                kind="release",
                available_delta=to_release,
                held_delta=-to_release,
                spent_delta=0,
                expired_delta=0,
                created_at=now,
            )
        )

        # Cross-period expiration check: if lot has expired while held, expire the returned credits separately
        if lot.expires_at is not None and lot.expires_at <= now and lot.available >= to_release:
            lot.available -= to_release
            lot.expired += to_release
            db.add(
                CreditLedgerRecord(
                    id=f"led-{uuid.uuid4().hex[:14]}",
                    workspace_id=res.workspace_id,
                    lot_id=lot.id,
                    reservation_id=res.id,
                    job_id=res.job_id,
                    order_id=None,
                    event_key=f"expire:{res.id}",
                    kind="expire",
                    available_delta=-to_release,
                    held_delta=0,
                    spent_delta=0,
                    expired_delta=to_release,
                    created_at=now,
                )
            )

    res.state = "released"
    res.actual = 0
    db.flush()
    return res


def build_billing_state(db: Session, workspace_id: str) -> BillingStateOut:
    settings = get_settings()
    now = utcnow()
    sub = db.scalar(
        select(SubscriptionRecord).where(SubscriptionRecord.workspace_id == workspace_id)
    )
    if not sub:
        sub = SubscriptionRecord(
            id=f"sub-{uuid.uuid4().hex[:12]}",
            workspace_id=workspace_id,
            plan_id=None,
            provider_sub_id=None,
            offer_version="trial-v1",
            state="trialing",
            period_start=now,
            period_end=None,
            cancel_at_period_end=False,
            updated_at=now,
        )
        db.add(sub)
        db.flush()

    # Check if subscription period has passed
    effective_sub_state = sub.state
    if sub.period_end is not None and sub.period_end <= now and sub.state in ("active", "trialing"):
        effective_sub_state = "expired"

    lots = list(
        db.scalars(
            select(CreditLotRecord)
            .where(CreditLotRecord.workspace_id == workspace_id)
            .order_by(CreditLotRecord.expires_at.asc().nulls_last(), CreditLotRecord.created_at.asc())
        ).all()
    )

    avail_total = 0
    held_total = 0
    spent_total = 0
    wallet_lots: list[WalletLotOut] = []
    for lot in lots:
        lot_avail = int(lot.available)
        if lot.expires_at is not None and lot.expires_at <= now:
            lot_avail = 0
        avail_total += lot_avail
        held_total += int(lot.held)
        spent_total += int(lot.spent)
        wallet_lots.append(
            WalletLotOut(
                id=lot.id,
                source=lot.source,  # type: ignore[arg-type]
                available=lot_avail,
                held=int(lot.held),
                expiresAt=iso_utc(lot.expires_at),
            )
        )

    usage = db.get(WorkspaceUsageRecord, workspace_id)
    active_jobs = int(usage.active_jobs) if usage else 0
    used_bytes = int(usage.used_bytes) if usage else 0

    is_paid_active = effective_sub_state == "active" and sub.plan_id is not None
    watermark = not is_paid_active
    max_concurrent = settings.default_max_concurrent_jobs
    storage_limit = settings.default_storage_limit_bytes
    canvas_node_limit = settings.default_canvas_node_limit

    if sub.plan_id:
        offer = db.get(OfferRecord, (sub.plan_id, sub.offer_version))
        if offer and effective_sub_state == "active":
            limits = offer.limits or {}
            max_concurrent = int(limits.get("maxConcurrentJobs", max_concurrent))
            storage_limit = int(limits.get("maxStorageBytes", storage_limit))
            canvas_node_limit = int(limits.get("maxCanvasNodes", canvas_node_limit))
            watermark = bool(limits.get("watermark", False))

    all_models = list(
        db.scalars(select(ModelCatalogRecord.id).where(ModelCatalogRecord.active.is_(True))).all()
    )

    return BillingStateOut(
        subscription=SubscriptionOut(
            planId=sub.plan_id,
            state=effective_sub_state,  # type: ignore[arg-type]
            periodStart=iso_utc(sub.period_start),
            periodEnd=iso_utc(sub.period_end),
            cancelAtPeriodEnd=bool(sub.cancel_at_period_end),
        ),
        entitlements=EntitlementsOut(
            availableCredits=avail_total,
            heldCredits=held_total,
            spentCredits=spent_total,
            maxConcurrentJobs=max_concurrent,
            activeJobs=active_jobs,
            allowedModelIds=all_models or ["studio-image", "illustration", "studio-video"],
            asOf=iso_utc(now) or "",
            watermark=watermark,
            storageLimitBytes=storage_limit,
            usedStorageBytes=used_bytes,
            canvasNodeLimit=canvas_node_limit,
            walletLots=wallet_lots,
            maxCanvasCount=settings.default_max_canvas_count,
            maxSeats=1,
        ),
        checkoutMode=settings.checkout_mode,  # type: ignore[arg-type]
    )
