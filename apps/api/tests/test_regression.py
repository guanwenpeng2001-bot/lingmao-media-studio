from __future__ import annotations

import hashlib
import hmac
import io
import json
import zipfile
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.billing.ledger import grant_credit_lot
from app.db import Base, get_engine, get_session_factory, reset_engine
from app.main import create_app
from app.models import (
    AssetVariantRecord,
    CreditLedgerRecord,
    CreditLotRecord,
    JobEventRecord,
    Member,
    OrderRecord,
    ProjectGrantRecord,
    User,
    utcnow,
)
from app.seed import seed_catalog_defaults
from app.worker import drain_all_queued

TEST_PAYMENT_SECRET = "test_payment_hmac_secret_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d"
TEST_GENERATION_SECRET = "test_generation_hmac_secret_1f2e3d4c5b6a79887766554433221100"


@pytest.fixture()
def sandbox_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db_file = tmp_path / "test_lingmao.db"
    storage_dir = tmp_path / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("LINGMAO_DATABASE_URL", f"sqlite+pysqlite:///{db_file.as_posix()}")
    monkeypatch.setenv("LINGMAO_STORAGE_DIR", storage_dir.as_posix())
    monkeypatch.setenv("LINGMAO_ENV_MODE", "sandbox")
    monkeypatch.setenv("LINGMAO_DEMO_INFERENCE_ENABLED", "true")
    monkeypatch.setenv("LINGMAO_SANDBOX_BILLING_ENABLED", "true")
    monkeypatch.setenv("LINGMAO_SANDBOX_OTP_ENABLED", "true")
    monkeypatch.setenv("LINGMAO_SANDBOX_OTP_CODE", "123456")
    monkeypatch.setenv("LINGMAO_PAYMENT_WEBHOOK_SECRET", TEST_PAYMENT_SECRET)
    monkeypatch.setenv("LINGMAO_GENERATION_WEBHOOK_SECRET", TEST_GENERATION_SECRET)
    monkeypatch.setenv("LINGMAO_INITIAL_TRIAL_CREDITS", "100")

    reset_engine()
    engine = get_engine()
    Base.metadata.create_all(bind=engine)
    with get_session_factory()() as db:
        seed_catalog_defaults(db)

    app = create_app()
    yield app, storage_dir

    reset_engine()


def _login_client(app, phone: str = "+8613800138000") -> tuple[TestClient, dict]:
    client = TestClient(app)
    r_otp = client.post("/api/v1/auth/otp", json={"phone": phone})
    assert r_otp.status_code == 202
    challenge_id = r_otp.json()["challengeId"]
    r_sess = client.post(
        "/api/v1/auth/session",
        json={"challengeId": challenge_id, "code": "123456", "agreementVersion": "v1.0"},
    )
    assert r_sess.status_code == 200
    return client, r_sess.json()


def _make_sample_png_bytes(color: tuple[int, int, int] = (40, 120, 200)) -> bytes:
    img = Image.new("RGB", (640, 640), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_sandbox_confirm_feature_flag_and_auth_gating(sandbox_env, monkeypatch: pytest.MonkeyPatch):
    app, _ = sandbox_env
    unauth_client = TestClient(app)

    # Sandbox enabled, but unauthenticated -> 401 UNAUTHENTICATED
    r_unauth = unauth_client.post("/api/v1/billing/checkout-sessions/chk-nonexistent/sandbox-confirm")
    assert r_unauth.status_code == 401
    assert r_unauth.json()["error"]["code"] == "UNAUTHENTICATED"

    # Sandbox billing disabled -> 404 FEATURE_DISABLED (even before auth check)
    monkeypatch.setenv("LINGMAO_SANDBOX_BILLING_ENABLED", "false")
    r_disabled = unauth_client.post("/api/v1/billing/checkout-sessions/chk-nonexistent/sandbox-confirm")
    assert r_disabled.status_code == 404
    assert r_disabled.json()["error"]["code"] == "FEATURE_DISABLED"

    # Production / live mode -> 404 FEATURE_DISABLED
    monkeypatch.setenv("LINGMAO_SANDBOX_BILLING_ENABLED", "true")
    monkeypatch.setenv("LINGMAO_ENV_MODE", "live")
    r_live = unauth_client.post("/api/v1/billing/checkout-sessions/chk-nonexistent/sandbox-confirm")
    assert r_live.status_code == 404
    assert r_live.json()["error"]["code"] == "FEATURE_DISABLED"


def test_sandbox_confirm_lifecycle_idempotency_and_states(sandbox_env):
    app, _ = sandbox_env
    owner_client, owner_sess = _login_client(app, "+8613800138001")
    other_client, _ = _login_client(app, "+8613800138002")

    # 1. Create a sandbox checkout session for plan-pro-month
    r_chk = owner_client.post(
        "/api/v1/billing/checkout-sessions",
        headers={"Idempotency-Key": "chk-create-pro-1"},
        json={"itemType": "subscription", "offerId": "plan-pro-month"},
    )
    assert r_chk.status_code == 201
    chk = r_chk.json()
    checkout_id = chk["id"]
    assert chk["status"] == "pending"
    assert chk["mode"] == "sandbox"
    assert chk["redirectUrl"] == f"/billing/checkout/{checkout_id}"

    # 2. Other user/workspace cannot confirm -> 404 NOT_FOUND
    r_other = other_client.post(
        f"/api/v1/billing/checkout-sessions/{checkout_id}/sandbox-confirm",
        headers={"Idempotency-Key": "other-attempt"},
    )
    assert r_other.status_code == 404
    assert r_other.json()["error"]["code"] == "NOT_FOUND"

    # 3. Empty/whitespace Idempotency-Key when header is explicitly sent -> 400 INVALID_IDEMPOTENCY_KEY
    r_bad_key = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{checkout_id}/sandbox-confirm",
        headers={"Idempotency-Key": "   "},
    )
    assert r_bad_key.status_code == 400
    assert r_bad_key.json()["error"]["code"] == "INVALID_IDEMPOTENCY_KEY"

    # 4. First confirmation (without Idempotency-Key header, or with header) settles order to paid
    r_confirm1 = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{checkout_id}/sandbox-confirm",
    )
    assert r_confirm1.status_code == 200
    confirmed1 = r_confirm1.json()
    assert confirmed1["id"] == checkout_id
    assert confirmed1["status"] == "paid"
    assert confirmed1["mode"] == "sandbox"
    assert confirmed1["redirectUrl"] == f"/billing/checkout/{checkout_id}"

    # 5. Repeat confirmation with deterministic Idempotency-Key and another key -> still 200, no double grant
    r_confirm2 = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{checkout_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-{checkout_id}"},
    )
    assert r_confirm2.status_code == 200
    assert r_confirm2.json()["status"] == "paid"

    r_confirm3 = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{checkout_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-alt-{checkout_id}"},
    )
    assert r_confirm3.status_code == 200
    assert r_confirm3.json()["status"] == "paid"

    # 6. Webhook replay for the same order -> 200, no double grant
    wh_payload = json.dumps(
        {
            "eventKey": f"evt-pay-{checkout_id}",
            "orderId": checkout_id,
            "tradeId": f"trd-{checkout_id}",
            "status": "paid",
            "mode": "sandbox",
            "amountMinor": 9900,
            "currency": "CNY",
        }
    ).encode("utf-8")
    sig = hmac.new(TEST_PAYMENT_SECRET.encode("utf-8"), wh_payload, hashlib.sha256).hexdigest()
    r_wh = owner_client.post(
        "/api/v1/billing/webhooks/sandbox-pay",
        content=wh_payload,
        headers={"Content-Type": "application/json", "Provider-Signature": sig},
    )
    assert r_wh.status_code == 200

    # Verify billing state & ledger have exactly 100 (trial) + 1000 (plan-pro-month) = 1100 credits
    r_state = owner_client.get("/api/v1/billing/state")
    assert r_state.status_code == 200
    bstate = r_state.json()
    assert bstate["subscription"]["planId"] == "plan-pro-month"
    assert bstate["subscription"]["state"] == "active"
    assert bstate["entitlements"]["watermark"] is False
    assert bstate["entitlements"]["availableCredits"] == 1100

    r_ledger = owner_client.get("/api/v1/billing/ledger")
    assert r_ledger.status_code == 200
    sub_grants = [
        item
        for item in r_ledger.json()["items"]
        if item["kind"] == "grant" and item["orderId"] == checkout_id
    ]
    assert len(sub_grants) == 1
    assert sub_grants[0]["availableDelta"] == 1000

    # 7. Even after original expires_at has passed, re-confirming the paid sandbox order returns 200
    with get_session_factory()() as db:
        ord_rec = db.get(OrderRecord, checkout_id)
        assert ord_rec is not None
        ord_rec.expires_at = utcnow() - timedelta(hours=2)
        db.commit()

    r_paid_after_expiry = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{checkout_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-{checkout_id}"},
    )
    assert r_paid_after_expiry.status_code == 200
    assert r_paid_after_expiry.json()["status"] == "paid"

    # 8. Create a second order: reusing first order's Idempotency-Key returns 409 IDEMPOTENCY_CONFLICT
    r_chk2 = owner_client.post(
        "/api/v1/billing/checkout-sessions",
        headers={"Idempotency-Key": "chk-create-pack-2"},
        json={"itemType": "credit_pack", "offerId": "pack-500"},
    )
    assert r_chk2.status_code == 201
    chk2_id = r_chk2.json()["id"]

    r_conflict = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{chk2_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-{checkout_id}"},
    )
    assert r_conflict.status_code == 409
    assert r_conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"

    # 9. Pending order that has expired returns 410 CHECKOUT_EXPIRED
    with get_session_factory()() as db:
        ord2 = db.get(OrderRecord, chk2_id)
        assert ord2 is not None
        ord2.expires_at = utcnow() - timedelta(minutes=5)
        db.commit()

    r_expired = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{chk2_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-{chk2_id}"},
    )
    assert r_expired.status_code == 410
    assert r_expired.json()["error"]["code"] == "CHECKOUT_EXPIRED"

    # 10. Cancelled order returns 409 CHECKOUT_CANCELLED, and live order returns 404 NOT_FOUND
    r_chk3 = owner_client.post(
        "/api/v1/billing/checkout-sessions",
        headers={"Idempotency-Key": "chk-create-pack-3"},
        json={"itemType": "credit_pack", "offerId": "pack-500"},
    )
    chk3_id = r_chk3.json()["id"]
    with get_session_factory()() as db:
        ord3 = db.get(OrderRecord, chk3_id)
        assert ord3 is not None
        ord3.state = "cancelled"
        db.commit()

    r_cancelled = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{chk3_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-{chk3_id}"},
    )
    assert r_cancelled.status_code == 409
    assert r_cancelled.json()["error"]["code"] == "CHECKOUT_CANCELLED"

    with get_session_factory()() as db:
        ord3 = db.get(OrderRecord, chk3_id)
        assert ord3 is not None
        ord3.state = "pending"
        ord3.mode = "live"
        db.commit()

    r_non_sandbox = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{chk3_id}/sandbox-confirm",
    )
    assert r_non_sandbox.status_code == 404
    assert r_non_sandbox.json()["error"]["code"] == "NOT_FOUND"

    # Balance must still be 1100
    assert owner_client.get("/api/v1/billing/state").json()["entitlements"]["availableCredits"] == 1100


def test_free_vs_pro_watermark_for_image_video_and_batch_zip_plus_viewer_rejection(sandbox_env):
    app, storage_dir = sandbox_env
    owner_client, owner_sess = _login_client(app, "+8613900139001")
    viewer_client, viewer_sess = _login_client(app, "+8613900139002")
    outsider_client, _ = _login_client(app, "+8613900139003")

    # Create project in owner workspace
    r_prj = owner_client.post(
        "/api/v1/projects",
        json={"name": "阶段六水印与权限回归项目", "industry": "ecommerce"},
    )
    assert r_prj.status_code == 201
    project_id = r_prj.json()["id"]

    # Add viewer_sess user as a read-only viewer (allow_download=False) in owner's workspace & project
    with get_session_factory()() as db:
        db.add(
            Member(
                workspace_id=owner_sess["workspaceId"],
                user_id=viewer_sess["userId"],
                role="viewer",
                status="active",
            )
        )
        db.add(
            ProjectGrantRecord(
                project_id=project_id,
                user_id=viewer_sess["userId"],
                workspace_id=owner_sess["workspaceId"],
                role="viewer",
                allow_copy=False,
                allow_download=False,
            )
        )
        # Update viewer's active session workspace_id
        from app.models import UserSession
        from sqlalchemy import select

        for us in db.scalars(select(UserSession).where(UserSession.user_id == viewer_sess["userId"])).all():
            us.workspace_id = owner_sess["workspaceId"]
        db.commit()

    # Upload a reference image
    png_bytes = _make_sample_png_bytes()
    r_up = owner_client.post(
        f"/api/v1/projects/{project_id}/assets",
        headers={"Idempotency-Key": "upload-ref-asset-1"},
        data={"assetRole": "product"},
        files={"file": ("product.png", png_bytes, "image/png")},
    )
    assert r_up.status_code == 201
    ref_asset_id = r_up.json()["id"]

    # Create and run a single video job (cost = 5 * 8 = 40 credits)
    r_vquote = owner_client.post(
        f"/api/v1/projects/{project_id}/quotes",
        json={
            "mode": "image_to_video",
            "modelId": "studio-video",
            "prompt": "电商测试短视频生成",
            "inputAssetIds": [ref_asset_id],
            "parameters": {"aspectRatio": "16:9", "durationSeconds": 5},
        },
    )
    assert r_vquote.status_code == 201
    vquote_id = r_vquote.json()["id"]

    r_vjob = owner_client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers={"Idempotency-Key": "submit-video-job-1"},
        json={"quoteId": vquote_id},
    )
    assert r_vjob.status_code == 202
    vjob_id = r_vjob.json()["id"]

    # Submitting the same consumed quote with a different Idempotency-Key returns 409 QUOTE_USED with existingJobId
    r_quote_used = owner_client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers={"Idempotency-Key": "submit-video-job-different-key"},
        json={"quoteId": vquote_id},
    )
    assert r_quote_used.status_code == 409
    assert r_quote_used.json()["error"]["code"] == "QUOTE_USED"
    assert r_quote_used.json()["error"]["details"]["existingJobId"] == vjob_id

    # Create and run a 2-image batch job (cost = 2 * 10 = 20 credits)
    r_bquote = owner_client.post(
        f"/api/v1/projects/{project_id}/batch-quotes",
        json={
            "input": {
                "mode": "product_scene",
                "modelId": "studio-image",
                "prompt": "批量主图水印回归测试",
                "inputAssetIds": [ref_asset_id],
                "parameters": {"aspectRatio": "1:1"},
            },
            "variants": [
                {"aspectRatio": "1:1", "quantity": 1, "outputKind": "white_background"},
                {"aspectRatio": "3:4", "quantity": 1, "outputKind": "scene"},
            ],
        },
    )
    assert r_bquote.status_code == 201
    bquote_id = r_bquote.json()["id"]

    r_batch = owner_client.post(
        f"/api/v1/projects/{project_id}/batches",
        headers={"Idempotency-Key": "submit-batch-1"},
        json={"quoteId": bquote_id},
    )
    assert r_batch.status_code == 202
    batch_id = r_batch.json()["id"]

    # Execute worker ticks until all jobs finish
    drain_all_queued("test-worker")

    vjob_out = owner_client.get(f"/api/v1/jobs/{vjob_id}").json()
    assert vjob_out["status"] == "succeeded"
    video_asset_id = vjob_out["outputAssetIds"][0]

    batch_out = owner_client.get(f"/api/v1/batches/{batch_id}").json()
    assert batch_out["status"] == "succeeded"
    first_batch_job = owner_client.get(f"/api/v1/jobs/{batch_out['jobIds'][0]}").json()
    image_asset_id = first_batch_job["outputAssetIds"][0]

    # --- Role & Cross-Workspace Checks ---
    # Viewer cannot download single asset, cannot read export license, cannot download batch ZIP, cannot create quotes
    assert (
        viewer_client.get(
            f"/api/v1/assets/{image_asset_id}/content?disposition=download"
        ).status_code
        == 403
    )
    assert viewer_client.get(f"/api/v1/assets/{image_asset_id}/license").status_code == 403
    r_viewer_zip = viewer_client.get(f"/api/v1/batches/{batch_id}/download")
    assert r_viewer_zip.status_code == 403
    assert r_viewer_zip.json()["error"]["code"] == "READ_ONLY"
    assert (
        viewer_client.post(
            f"/api/v1/projects/{project_id}/quotes",
            json={
                "mode": "product_scene",
                "modelId": "studio-image",
                "prompt": "只读角色拒绝写入",
                "inputAssetIds": [ref_asset_id],
                "parameters": {"aspectRatio": "1:1"},
            },
        ).status_code
        == 403
    )

    # Outsider from another workspace gets 404 on asset, job, batch, and batch download
    assert outsider_client.get(f"/api/v1/assets/{image_asset_id}").status_code == 404
    assert outsider_client.get(f"/api/v1/jobs/{vjob_id}").status_code == 404
    assert outsider_client.get(f"/api/v1/batches/{batch_id}/download").status_code == 404

    # --- Free Tier Watermark Verification ---
    # 1. Free Image Download -> watermarked
    r_free_img = owner_client.get(
        f"/api/v1/assets/{image_asset_id}/content?disposition=download"
    )
    assert r_free_img.status_code == 200
    assert r_free_img.headers["X-Lingmao-Watermark"] == "free-tier"
    free_img_sha = hashlib.sha256(r_free_img.content).hexdigest()

    # 2. Free Video Download + Range -> watermarked MP4 via ffmpeg
    r_free_vid = owner_client.get(
        f"/api/v1/assets/{video_asset_id}/content?disposition=download"
    )
    assert r_free_vid.status_code == 200
    assert r_free_vid.headers["X-Lingmao-Watermark"] == "free-tier"
    assert b"ftyp" in r_free_vid.content[:64]
    free_vid_sha = hashlib.sha256(r_free_vid.content).hexdigest()

    r_free_vid_range = owner_client.get(
        f"/api/v1/assets/{video_asset_id}/content?disposition=preview",
        headers={"Range": "bytes=0-255"},
    )
    assert r_free_vid_range.status_code == 206
    assert r_free_vid_range.headers["X-Lingmao-Watermark"] == "free-tier"
    assert r_free_vid_range.content == r_free_vid.content[:256]

    # 3. Free Batch ZIP Download -> contains watermarked variants, never raw unwatermarked files
    r_free_zip = owner_client.get(f"/api/v1/batches/{batch_id}/download")
    assert r_free_zip.status_code == 200
    assert r_free_zip.headers["X-Lingmao-Watermark"] == "free-tier"
    with zipfile.ZipFile(io.BytesIO(r_free_zip.content), "r") as zf:
        names = zf.namelist()
        assert len(names) == 2
        matching_entry = [n for n in names if image_asset_id in n][0]
        zip_entry_sha = hashlib.sha256(zf.read(matching_entry)).hexdigest()
        assert zip_entry_sha == free_img_sha

    # --- Upgrade to Pro via sandbox-confirm and Verify Unwatermarked Delivery ---
    r_chk = owner_client.post(
        "/api/v1/billing/checkout-sessions",
        headers={"Idempotency-Key": "upgrade-pro-for-watermark-test"},
        json={"itemType": "subscription", "offerId": "plan-pro-month"},
    )
    assert r_chk.status_code == 201
    chk_id = r_chk.json()["id"]
    r_conf = owner_client.post(
        f"/api/v1/billing/checkout-sessions/{chk_id}/sandbox-confirm",
        headers={"Idempotency-Key": f"sandbox-confirm-{chk_id}"},
    )
    assert r_conf.status_code == 200
    assert r_conf.json()["status"] == "paid"

    # 1. Pro Image Download -> unwatermarked original
    r_pro_img = owner_client.get(
        f"/api/v1/assets/{image_asset_id}/content?disposition=download"
    )
    assert r_pro_img.status_code == 200
    assert r_pro_img.headers["X-Lingmao-Watermark"] == "none"
    pro_img_sha = hashlib.sha256(r_pro_img.content).hexdigest()
    assert pro_img_sha != free_img_sha

    # 2. Pro Video Download -> unwatermarked original
    r_pro_vid = owner_client.get(
        f"/api/v1/assets/{video_asset_id}/content?disposition=download"
    )
    assert r_pro_vid.status_code == 200
    assert r_pro_vid.headers["X-Lingmao-Watermark"] == "none"
    pro_vid_sha = hashlib.sha256(r_pro_vid.content).hexdigest()
    assert pro_vid_sha != free_vid_sha

    # 3. Pro Batch ZIP Download -> contains unwatermarked originals
    r_pro_zip = owner_client.get(f"/api/v1/batches/{batch_id}/download")
    assert r_pro_zip.status_code == 200
    assert r_pro_zip.headers["X-Lingmao-Watermark"] == "none"
    with zipfile.ZipFile(io.BytesIO(r_pro_zip.content), "r") as zf:
        names = zf.namelist()
        matching_entry = [n for n in names if image_asset_id in n][0]
        assert hashlib.sha256(zf.read(matching_entry)).hexdigest() == pro_img_sha

    # Check asset_variants table recorded watermarked variants for both image and video
    with get_session_factory()() as db:
        from sqlalchemy import select

        variants = list(
            db.scalars(
                select(AssetVariantRecord).where(
                    AssetVariantRecord.asset_id.in_([image_asset_id, video_asset_id])
                )
            ).all()
        )
        assert len(variants) == 2


def test_credit_lot_deduction_order_insufficient_credits_cancel_refund_and_sse_cursor(sandbox_env):
    app, _ = sandbox_env
    client, sess = _login_client(app, "+8613700137001")
    workspace_id = sess["workspaceId"]

    r_prj = client.post(
        "/api/v1/projects",
        json={"name": "账本顺序与SSE回归项目", "industry": "ecommerce"},
    )
    project_id = r_prj.json()["id"]

    r_up = client.post(
        f"/api/v1/projects/{project_id}/assets",
        headers={"Idempotency-Key": "upload-item-asset-1"},
        data={"assetRole": "product"},
        files={"file": ("item.png", _make_sample_png_bytes(), "image/png")},
    )
    asset_id = r_up.json()["id"]

    # Insert a pack lot that expires EARLIER than the trial lot to verify source priority (trial -> subscription -> pack)
    now = utcnow()
    with get_session_factory()() as db:
        early_lot = grant_credit_lot(
            db=db,
            workspace_id=workspace_id,
            source="pack",
            grant_key="test:early-pack",
            credits=50,
            expires_at=now + timedelta(days=1),
        )
        early_lot_id = early_lot.id
        db.commit()

    # Quote and submit a 10-credit image job
    r_q1 = client.post(
        f"/api/v1/projects/{project_id}/quotes",
        json={
            "mode": "product_scene",
            "modelId": "studio-image",
            "prompt": "测试积分池扣减顺序",
            "inputAssetIds": [asset_id],
            "parameters": {"aspectRatio": "1:1"},
        },
    )
    q1_id = r_q1.json()["id"]
    r_j1 = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers={"Idempotency-Key": "job-order-test-1"},
        json={"quoteId": q1_id},
    )
    assert r_j1.status_code == 202
    j1_id = r_j1.json()["id"]

    # Verify trial lot was deducted (100 -> 90) and early pack lot is untouched (50)
    with get_session_factory()() as db:
        pack_lot = db.get(CreditLotRecord, early_lot_id)
        assert pack_lot is not None and pack_lot.available == 50 and pack_lot.held == 0

    # Cancel the queued job -> credits released back to 150 available, 0 held
    r_cancel = client.post(
        f"/api/v1/jobs/{j1_id}/cancel",
        headers={"Idempotency-Key": "cancel-job-1"},
        json={"confirmRunning": False},
    )
    assert r_cancel.status_code == 200
    assert r_cancel.json()["status"] == "cancelled"

    bstate = client.get("/api/v1/billing/state").json()
    assert bstate["entitlements"]["availableCredits"] == 150
    assert bstate["entitlements"]["heldCredits"] == 0

    # Test INSUFFICIENT_CREDITS when requesting a 24-item batch (240 credits > 150 available)
    r_bq = client.post(
        f"/api/v1/projects/{project_id}/batch-quotes",
        json={
            "input": {
                "mode": "product_scene",
                "modelId": "studio-image",
                "prompt": "余额不足测试",
                "inputAssetIds": [asset_id],
                "parameters": {"aspectRatio": "1:1"},
            },
            "variants": [
                {"aspectRatio": "1:1", "quantity": 10, "outputKind": "scene"},
                {"aspectRatio": "3:4", "quantity": 10, "outputKind": "hero"},
            ],
        },
    )
    assert r_bq.status_code == 201
    r_bsub = client.post(
        f"/api/v1/projects/{project_id}/batches",
        headers={"Idempotency-Key": "batch-insufficient-1"},
        json={"quoteId": r_bq.json()["id"]},
    )
    assert r_bsub.status_code == 409
    err = r_bsub.json()["error"]
    assert err["code"] == "INSUFFICIENT_CREDITS"
    assert err["details"]["required"] == 300
    assert err["details"]["available"] == 150
    assert err["details"]["shortfall"] == 150

    # --- SSE /api/v1/events/jobs Cursor Matching & Expiration ---
    # We have events seq=1 (queued) and seq=2 (cancelled) for j1_id
    r_sse_q = client.get("/api/v1/events/jobs?lastEventId=1")
    assert r_sse_q.status_code == 200
    assert "id: 2" in r_sse_q.text
    assert "id: 1\n" not in r_sse_q.text

    # Header takes precedence over query parameter
    r_sse_hdr = client.get(
        "/api/v1/events/jobs?lastEventId=invalid_ignored",
        headers={"Last-Event-ID": "1"},
    )
    assert r_sse_hdr.status_code == 200
    assert "id: 2" in r_sse_hdr.text

    # Invalid cursor format -> 400 INVALID_INPUT
    r_sse_bad = client.get("/api/v1/events/jobs?lastEventId=not-a-number")
    assert r_sse_bad.status_code == 400
    assert r_sse_bad.json()["error"]["code"] == "INVALID_INPUT"

    # Non-existent / expired cursor -> 410 CURSOR_EXPIRED
    r_sse_exp = client.get("/api/v1/events/jobs", headers={"Last-Event-ID": "9999"})
    assert r_sse_exp.status_code == 410
    assert r_sse_exp.json()["error"]["code"] == "CURSOR_EXPIRED"

    # Invalid webhook signature -> 400 INVALID_SIGNATURE with no side effects
    r_bad_wh = client.post(
        "/api/v1/billing/webhooks/sandbox-pay",
        content=b'{"orderId":"chk-1"}',
        headers={"Content-Type": "application/json", "Provider-Signature": "deadbeef"},
    )
    assert r_bad_wh.status_code == 400
    assert r_bad_wh.json()["error"]["code"] == "INVALID_SIGNATURE"
