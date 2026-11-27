from __future__ import annotations

import json
import urllib.parse
import uuid
from datetime import datetime, timedelta
from typing import Any
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.auth.deps import (
    AuthContext,
    canonical_digest,
    check_request_idempotency,
    get_current_context,
    save_request_idempotency,
    sha256_hex,
)
from app.billing.ledger import build_billing_state, grant_credit_lot, lock_workspace_usage
from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import (
    BillingInboxRecord,
    CreditLedgerRecord,
    JobRecord,
    OfferRecord,
    OrderRecord,
    SubscriptionRecord,
    utcnow,
)
from app.providers.payment import (
    ensure_billing_available,
    validate_payment_webhook_secret,
    verify_payment_webhook_signature,
)
from app.schemas import (
    BillingStateOut,
    CheckoutOut,
    CheckoutRequest,
    CreditPackOut,
    LedgerEntryOut,
    LedgerPage,
    PlanOut,
    iso_utc,
)

router = APIRouter()


def _order_to_checkout(order: OrderRecord) -> CheckoutOut:
    return CheckoutOut(
        id=order.id,
        status=order.state,  # type: ignore[arg-type]
        mode=order.mode,  # type: ignore[arg-type]
        redirectUrl=order.redirect_url,
        expiresAt=iso_utc(order.expires_at) or "",
        itemType=order.item_type,  # type: ignore[arg-type]
        offerId=order.offer_id,
    )


@router.get("/billing/plans", response_model=list[PlanOut])
def list_plans(db: Session = Depends(get_db)) -> list[PlanOut]:
    offers = list(
        db.scalars(
            select(OfferRecord)
            .where(OfferRecord.type == "subscription", OfferRecord.active.is_(True))
            .order_by(OfferRecord.price_minor.asc())
        ).all()
    )
    result: list[PlanOut] = []
    for o in offers:
        limits = o.limits or {}
        result.append(
            PlanOut(
                id=o.id,
                name=o.name,
                interval=(o.interval or "month"),  # type: ignore[arg-type]
                priceMinor=int(o.price_minor),
                currency=o.currency,
                periodCredits=int(o.credits),
                maxConcurrentJobs=int(limits.get("maxConcurrentJobs", 4)),
                modelIds=list(limits.get("modelIds", ["studio-image", "illustration", "studio-video"])),
                watermark=bool(limits.get("watermark", False)),
                maxCanvasNodes=int(limits.get("maxCanvasNodes", 500)),
                maxStorageBytes=int(limits.get("maxStorageBytes", 10 * 1024 * 1024 * 1024)),
                maxResolution=str(limits.get("maxResolution", "2k")),
                commercialTermsUrl=limits.get("commercialTermsUrl"),
                offerVersion=o.version,
            )
        )
    return result


@router.get("/billing/credit-packs", response_model=list[CreditPackOut])
def list_packs(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> list[CreditPackOut]:
    offers = list(
        db.scalars(
            select(OfferRecord)
            .where(OfferRecord.type == "credit_pack", OfferRecord.active.is_(True))
            .order_by(OfferRecord.price_minor.asc())
        ).all()
    )
    return [
        CreditPackOut(
            id=o.id,
            name=o.name,
            credits=int(o.credits),
            priceMinor=int(o.price_minor),
            currency=o.currency,
            expiresInDays=o.expires_in_days,
        )
        for o in offers
    ]


@router.get("/billing/state", response_model=BillingStateOut)
def get_billing(
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> BillingStateOut:
    state = build_billing_state(db, ctx.workspace_id)
    db.commit()
    return state


@router.get("/billing/ledger", response_model=LedgerPage)
def get_ledger(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    from_dt: datetime | None = Query(default=None, alias="from"),
    until_dt: datetime | None = Query(default=None, alias="until"),
    project_id: str | None = Query(default=None, alias="projectId"),
    kind: str | None = Query(default=None),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> LedgerPage:
    stmt = select(CreditLedgerRecord).where(CreditLedgerRecord.workspace_id == ctx.workspace_id)
    if kind:
        stmt = stmt.where(CreditLedgerRecord.kind == kind)
    if from_dt:
        stmt = stmt.where(CreditLedgerRecord.created_at >= from_dt)
    if until_dt:
        stmt = stmt.where(CreditLedgerRecord.created_at < until_dt)
    if project_id:
        job_ids_sub = select(JobRecord.id).where(
            JobRecord.workspace_id == ctx.workspace_id,
            JobRecord.project_id == project_id,
        )
        stmt = stmt.where(CreditLedgerRecord.job_id.in_(job_ids_sub))

    stmt = stmt.order_by(CreditLedgerRecord.created_at.desc(), CreditLedgerRecord.id.desc())
    rows = list(db.scalars(stmt).all())

    start_idx = 0
    if cursor:
        for idx, r in enumerate(rows):
            if r.id == cursor:
                start_idx = idx + 1
                break

    page_rows = rows[start_idx : start_idx + limit]
    next_cursor = page_rows[-1].id if len(rows) > start_idx + limit and page_rows else None

    return LedgerPage(
        items=[
            LedgerEntryOut(
                id=r.id,
                kind=r.kind,  # type: ignore[arg-type]
                jobId=r.job_id,
                orderId=r.order_id,
                availableDelta=int(r.available_delta),
                heldDelta=int(r.held_delta),
                spentDelta=int(r.spent_delta),
                at=iso_utc(r.created_at) or "",
                expiredDelta=int(r.expired_delta),
            )
            for r in page_rows
        ],
        nextCursor=next_cursor,
    )


@router.post("/billing/checkout-sessions", response_model=CheckoutOut, status_code=201)
def begin_checkout(
    body: CheckoutRequest,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CheckoutOut:
    if ctx.role == "viewer":
        raise AppError(403, "READ_ONLY", "只读成员不能发起支付购买")
    mode = ensure_billing_available()
    lock_workspace_usage(db, ctx.workspace_id)

    digest = canonical_digest(body.model_dump())
    existing = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "beginCheckout", "billing", idempotency_key, digest
    )
    if existing:
        order = db.get(OrderRecord, existing.resource_id)
        if order:
            return _order_to_checkout(order)

    offer = db.scalar(
        select(OfferRecord).where(
            OfferRecord.id == body.offerId,
            OfferRecord.type == body.itemType,
            OfferRecord.active.is_(True),
        )
    )
    if not offer and not body.offerId.startswith("plan-"):
        offer = db.scalar(
            select(OfferRecord).where(
                OfferRecord.id == f"plan-{body.offerId}",
                OfferRecord.type == body.itemType,
                OfferRecord.active.is_(True),
            )
        )
    if not offer:
        raise AppError(404, "NOT_FOUND", f"套餐或积分包 {body.offerId} 不存在")

    now = utcnow()
    order_id = f"chk-{uuid.uuid4().hex[:14]}"
    order = OrderRecord(
        id=order_id,
        workspace_id=ctx.workspace_id,
        actor=ctx.user_id,
        offer_id=body.offerId,
        offer_version=offer.version,
        item_type=body.itemType,
        provider="sandbox-pay" if mode == "sandbox" else "live-pay",
        mode=mode,
        amount_minor=offer.price_minor,
        currency=offer.currency,
        state="pending",
        provider_trade_id=None,
        redirect_url=f"/billing/checkout/{order_id}",
        expires_at=now + timedelta(minutes=30),
        created_at=now,
    )
    db.add(order)
    save_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "beginCheckout", "billing", idempotency_key, digest, order.id, 201
    )
    db.commit()
    return _order_to_checkout(order)


@router.get("/billing/checkout-sessions/{checkoutId}", response_model=CheckoutOut)
def get_checkout(
    checkoutId: str,
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> CheckoutOut:
    order = db.scalar(
        select(OrderRecord).where(
            OrderRecord.id == checkoutId,
            OrderRecord.workspace_id == ctx.workspace_id,
            OrderRecord.actor == ctx.user_id,
        )
    )
    if not order:
        raise AppError(404, "NOT_FOUND", "支付会话不存在")
    if order.state == "pending" and order.expires_at <= utcnow():
        order.state = "expired"
        db.commit()
    return _order_to_checkout(order)


def _settle_paid_order_tx(
    db: Session,
    order: OrderRecord,
    trade_id: str,
    now: datetime,
) -> None:
    lock_workspace_usage(db, order.workspace_id)
    offer = db.get(OfferRecord, (order.offer_id, order.offer_version)) or (
        db.get(OfferRecord, (f"plan-{order.offer_id}", order.offer_version))
        if not order.offer_id.startswith("plan-")
        else None
    )
    if not offer:
        raise AppError(400, "OFFER_NOT_FOUND", "订单关联商品目录不存在")

    was_already_paid = order.state == "paid"
    if not was_already_paid:
        order.state = "paid"
        order.provider_trade_id = trade_id

    expires_days = offer.expires_in_days or 30
    expires_at = now + timedelta(days=expires_days)
    source = "subscription" if order.item_type == "subscription" else "pack"
    grant_credit_lot(
        db=db,
        workspace_id=order.workspace_id,
        source=source,
        grant_key=f"order:{order.id}",
        credits=int(offer.credits),
        expires_at=expires_at,
        order_id=order.id,
    )

    if order.item_type == "subscription" and not was_already_paid:
        sub = db.scalar(
            select(SubscriptionRecord)
            .where(SubscriptionRecord.workspace_id == order.workspace_id)
            .with_for_update()
        )
        if not sub:
            sub = SubscriptionRecord(
                id=f"sub-{uuid.uuid4().hex[:12]}",
                workspace_id=order.workspace_id,
                plan_id=order.offer_id,
                provider_sub_id=trade_id,
                offer_version=offer.version,
                state="active",
                period_start=now,
                period_end=expires_at,
                cancel_at_period_end=False,
                updated_at=now,
            )
            db.add(sub)
        else:
            sub.plan_id = order.offer_id
            sub.provider_sub_id = trade_id
            sub.offer_version = offer.version
            sub.state = "active"
            sub.period_start = now
            sub.period_end = expires_at
            sub.cancel_at_period_end = False
            sub.updated_at = now


@router.post("/billing/checkout-sessions/{checkoutId}/sandbox-confirm", response_model=CheckoutOut)
def confirm_sandbox_checkout(
    checkoutId: str,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    db: Session = Depends(get_db),
) -> CheckoutOut:
    settings = get_settings()
    if not settings.is_sandbox_billing:
        raise AppError(404, "FEATURE_DISABLED", "当前环境未启用沙盒支付")

    ctx = get_current_context(request, db)

    order = db.scalar(
        select(OrderRecord)
        .where(
            OrderRecord.id == checkoutId,
            OrderRecord.workspace_id == ctx.workspace_id,
            OrderRecord.actor == ctx.user_id,
            OrderRecord.mode == "sandbox",
        )
        .with_for_update()
    )
    if not order:
        raise AppError(404, "NOT_FOUND", "未找到订单")
    if ctx.role == "viewer":
        raise AppError(403, "READ_ONLY", "只读成员不能确认支付")

    raw_key = (idempotency_key or "").strip()
    if not raw_key or len(raw_key) > 128 or not raw_key.isprintable():
        raise AppError(400, "INVALID_IDEMPOTENCY_KEY", "确认请求需要有效的幂等键")

    lock_workspace_usage(db, ctx.workspace_id)
    digest = canonical_digest({"checkoutId": order.id})
    existing = check_request_idempotency(
        db,
        ctx.workspace_id,
        ctx.user_id,
        "confirmSandboxCheckout",
        "billing",
        raw_key,
        digest,
    )

    if order.state == "paid":
        if existing is None:
            save_request_idempotency(
                db,
                ctx.workspace_id,
                ctx.user_id,
                "confirmSandboxCheckout",
                "billing",
                raw_key,
                digest,
                order.id,
                200,
            )
            db.commit()
        return _order_to_checkout(order)

    if order.state == "cancelled":
        raise AppError(409, "CHECKOUT_CANCELLED", "订单已取消")

    now = utcnow()
    if order.state == "expired" or (order.state == "pending" and order.expires_at <= now):
        if order.state == "pending":
            order.state = "expired"
            db.commit()
        raise AppError(410, "CHECKOUT_EXPIRED", "订单已过期，请重新创建订单")

    _settle_paid_order_tx(db, order, trade_id=f"sbx-trd-{order.id}", now=now)
    if existing is None:
        save_request_idempotency(
            db,
            ctx.workspace_id,
            ctx.user_id,
            "confirmSandboxCheckout",
            "billing",
            raw_key,
            digest,
            order.id,
            200,
        )
    db.commit()
    return _order_to_checkout(order)


@router.post("/billing/subscription/stop-renewal", response_model=BillingStateOut)
def stop_renewal(
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ctx: AuthContext = Depends(get_current_context),
    db: Session = Depends(get_db),
) -> BillingStateOut:
    if ctx.role == "viewer":
        raise AppError(403, "READ_ONLY", "只读成员无权变更订阅设置")
    ensure_billing_available()
    lock_workspace_usage(db, ctx.workspace_id)
    digest = canonical_digest({"action": "stop_renewal"})
    existing = check_request_idempotency(
        db, ctx.workspace_id, ctx.user_id, "stopRenewal", "billing", idempotency_key, digest
    )
    sub = db.scalar(
        select(SubscriptionRecord)
        .where(SubscriptionRecord.workspace_id == ctx.workspace_id)
        .with_for_update()
    )
    if not sub or sub.state not in ("active", "trialing"):
        raise AppError(409, "SUBSCRIPTION_NOT_ACTIVE", "当前无生效中的自动续订会员")

    if not existing:
        sub.cancel_at_period_end = True
        sub.updated_at = utcnow()
        save_request_idempotency(
            db, ctx.workspace_id, ctx.user_id, "stopRenewal", "billing", idempotency_key, digest, sub.id, 200
        )
    state = build_billing_state(db, ctx.workspace_id)
    db.commit()
    return state


@router.post("/billing/webhooks/{provider}", status_code=200)
async def receive_payment_event(
    provider: str,
    request: Request,
    provider_signature: str | None = Header(default=None, alias="Provider-Signature"),
    db: Session = Depends(get_db),
) -> Response:
    validate_payment_webhook_secret()
    ensure_billing_available()
    raw_body = await request.body()
    if not verify_payment_webhook_signature(raw_body, provider_signature):
        raise AppError(400, "INVALID_SIGNATURE", "支付回调签名验证未通过")

    ctype = request.headers.get("content-type", "")
    payload: dict[str, Any]
    try:
        if "application/x-www-form-urlencoded" in ctype:
            parsed = urllib.parse.parse_qs(raw_body.decode("utf-8"), keep_blank_values=True)
            payload = {k: v[0] if len(v) == 1 else v for k, v in parsed.items()}
        else:
            payload = json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise AppError(400, "INVALID_PAYLOAD", f"回调负载格式错误: {exc}") from exc

    settings = get_settings()
    environment = str(payload.get("environment") or settings.env_mode)
    if environment != settings.env_mode:
        raise AppError(400, "ENVIRONMENT_MISMATCH", "支付通知环境与当前服务环境不匹配")

    event_key = str(payload.get("eventId") or payload.get("event_key") or sha256_hex(raw_body))
    order_id = str(payload.get("orderId") or payload.get("checkoutId") or "")
    trade_id = str(payload.get("tradeId") or payload.get("providerTradeId") or f"trd-{order_id}")
    amount_minor = int(payload.get("amountMinor", -1))
    currency = str(payload.get("currency") or "CNY")
    trade_status = str(payload.get("status") or "paid")

    if not order_id:
        raise AppError(400, "MISSING_ORDER_ID", "支付回调缺少 orderId/checkoutId")

    now = utcnow()
    payload_digest = sha256_hex(raw_body)
    inbox = db.get(BillingInboxRecord, (provider, environment, event_key))
    if inbox is not None and inbox.processed_at is not None:
        return Response(status_code=200)

    if inbox is None:
        inbox = BillingInboxRecord(
            provider=provider,
            environment=environment,
            event_key=event_key,
            payload_digest=payload_digest,
            verified_at=now,
            processed_at=None,
        )
        db.add(inbox)
        db.flush()

    order = db.scalar(select(OrderRecord).where(OrderRecord.id == order_id).with_for_update())
    if not order:
        raise AppError(400, "ORDER_NOT_FOUND", "支付回调关联订单不存在")

    lock_workspace_usage(db, order.workspace_id)

    if amount_minor >= 0 and amount_minor != int(order.amount_minor):
        raise AppError(400, "AMOUNT_MISMATCH", "实付金额与订单金额不一致")
    if currency != order.currency:
        raise AppError(400, "CURRENCY_MISMATCH", "支付币种与订单币种不一致")

    offer = db.get(OfferRecord, (order.offer_id, order.offer_version))
    if not offer:
        raise AppError(400, "OFFER_NOT_FOUND", "订单关联商品目录不存在")

    if trade_status == "paid":
        _settle_paid_order_tx(db, order, trade_id=trade_id, now=now)
    elif trade_status == "cancelled":
        if order.state == "pending":
            order.state = "cancelled"

    inbox.processed_at = now
    db.commit()
    return Response(status_code=200)
