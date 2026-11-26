from __future__ import annotations

from sqlalchemy.orm import Session
from app.models import (
    ModelCatalogRecord,
    OfferRecord,
    PlatformPresetRecord,
    PortraitCatalogRecord,
    TemplateRecord,
)


def seed_catalog_defaults(db: Session) -> None:
    models = [
        ModelCatalogRecord(
            id="studio-image",
            version=1,
            label="灵猫电商视觉大模型 V1",
            modes=[
                "product_scene",
                "text_to_image",
                "image_to_image",
                "image_edit",
                "subject_cutout",
                "remove_background",
                "outpaint",
                "upscale",
                "try_on",
                "hand_held",
                "worn",
            ],
            aspect_ratios=["1:1", "3:4", "4:3", "9:16", "16:9"],
            duration_seconds=[],
            max_input_images=4,
            max_input_clips=0,
            resolutions=["1k", "2k"],
            native_audio=False,
            supports_last_frame=False,
            supports_locked_subject=True,
            submission_recovery="idempotent_key",
            pricing_version="test-rate-v1",
            base_credits=15,
            availability="available",
            active=True,
        ),
        ModelCatalogRecord(
            id="illustration",
            version=1,
            label="灵猫海报与创意插画模型 V1",
            modes=[
                "text_to_image",
                "image_to_image",
                "image_edit",
                "outpaint",
                "upscale",
            ],
            aspect_ratios=["1:1", "3:4", "4:3", "9:16", "16:9"],
            duration_seconds=[],
            max_input_images=4,
            max_input_clips=0,
            resolutions=["1k", "2k"],
            native_audio=False,
            supports_last_frame=False,
            supports_locked_subject=False,
            submission_recovery="idempotent_key",
            pricing_version="test-rate-v1",
            base_credits=10,
            availability="available",
            active=True,
        ),
        ModelCatalogRecord(
            id="studio-video",
            version=1,
            label="灵猫带货短视频大模型 Wan2.1/LTX",
            modes=[
                "image_to_video",
                "text_to_video",
                "video_compose",
            ],
            aspect_ratios=["9:16", "16:9", "1:1", "3:4"],
            duration_seconds=[5, 10],
            max_input_images=2,
            max_input_clips=8,
            resolutions=["720p", "1080p"],
            native_audio=True,
            supports_last_frame=True,
            supports_locked_subject=True,
            submission_recovery="idempotent_key",
            pricing_version="test-rate-v1",
            base_credits=40,
            availability="available",
            active=True,
        ),
    ]
    for m in models:
        if not db.get(ModelCatalogRecord, (m.id, m.version)):
            db.add(m)

    presets = [
        PlatformPresetRecord(
            id="taobao-main-1x1",
            version=1,
            platform="taobao",
            name="淘宝/天猫 1:1 方形主图",
            aspect_ratio="1:1",
            width=800,
            height=800,
            safe_area={"top": 0.08, "right": 0.08, "bottom": 0.12, "left": 0.08},
        ),
        PlatformPresetRecord(
            id="tmall-vertical-3x4",
            version=1,
            platform="tmall",
            name="天猫/京东 3:4 竖版主图",
            aspect_ratio="3:4",
            width=750,
            height=1000,
            safe_area={"top": 0.1, "right": 0.08, "bottom": 0.15, "left": 0.08},
        ),
        PlatformPresetRecord(
            id="douyin-video-9x16",
            version=1,
            platform="douyin",
            name="抖音/快手 9:16 带货短视频与竖屏海报",
            aspect_ratio="9:16",
            width=720,
            height=1280,
            safe_area={"top": 0.12, "right": 0.08, "bottom": 0.22, "left": 0.08},
        ),
    ]
    for p in presets:
        if not db.get(PlatformPresetRecord, (p.id, p.version)):
            db.add(p)

    templates = [
        TemplateRecord(
            id="tpl-ecom-desk-scene",
            version=1,
            scope="official",
            workspace_id=None,
            name="暖光木质桌面数码主图工作流",
            industry="ecommerce",
            prompt="将商品置于暖光木质书桌，保留商品轮廓与品牌字样，柔和自然光影。",
            suggested_modes=["product_scene", "image_to_video"],
            aspect_ratio="1:1",
            tags=["数码", "桌面", "主图", "短视频"],
            graph={
                "schemaVersion": 1,
                "viewport": {"x": 0, "y": 0, "zoom": 1},
                "nodes": [
                    {
                        "id": "node-product-placeholder",
                        "type": "placeholder",
                        "position": {"x": 100, "y": 200},
                        "expectedKind": "subject",
                        "label": "商品主体占位",
                    },
                    {
                        "id": "node-scene-gen",
                        "type": "generation",
                        "position": {"x": 450, "y": 200},
                        "mode": "product_scene",
                        "label": "场景图生成",
                        "config": {
                            "modelId": "studio-image",
                            "prompt": "将商品置于暖光木质书桌，保留商品轮廓与品牌字样。",
                            "parameters": {"aspectRatio": "1:1", "resolution": "1k"},
                        },
                    },
                ],
                "edges": [
                    {
                        "id": "edge-1",
                        "source": "node-product-placeholder",
                        "target": "node-scene-gen",
                        "role": "reference",
                        "ordinal": 0,
                    }
                ],
            },
        ),
        TemplateRecord(
            id="tpl-general-poster",
            version=1,
            scope="official",
            workspace_id=None,
            name="极简品牌海报与创意分镜",
            industry="general",
            prompt="现代极简主义风格海报，柔和光影与几何留白构图。",
            suggested_modes=["text_to_image", "text_to_video"],
            aspect_ratio="3:4",
            tags=["海报", "通用", "分镜"],
            graph={
                "schemaVersion": 1,
                "viewport": {"x": 0, "y": 0, "zoom": 1},
                "nodes": [
                    {
                        "id": "node-prompt",
                        "type": "text",
                        "position": {"x": 100, "y": 180},
                        "text": "现代极简主义风格海报，柔和光影与几何留白构图。",
                        "label": "创意提示词",
                    },
                    {
                        "id": "node-t2i",
                        "type": "generation",
                        "position": {"x": 420, "y": 180},
                        "mode": "text_to_image",
                        "label": "海报生成",
                        "config": {
                            "modelId": "illustration",
                            "prompt": "现代极简主义风格海报，柔和光影与几何留白构图。",
                            "parameters": {"aspectRatio": "3:4", "resolution": "1k"},
                        },
                    },
                ],
                "edges": [
                    {
                        "id": "edge-prompt-1",
                        "source": "node-prompt",
                        "target": "node-t2i",
                        "role": "prompt",
                        "ordinal": 0,
                    }
                ],
            },
        ),
    ]
    for t in templates:
        if not db.get(TemplateRecord, (t.id, t.version)):
            db.add(t)

    offers = [
        OfferRecord(
            id="plan-pro-month",
            version="v1",
            type="subscription",
            name="灵猫专业版月卡",
            interval="month",
            currency="CNY",
            price_minor=9900,
            credits=1000,
            expires_in_days=30,
            limits={
                "maxConcurrentJobs": 4,
                "modelIds": ["studio-image", "illustration", "studio-video"],
                "watermark": False,
                "maxCanvasNodes": 500,
                "maxStorageBytes": 10 * 1024 * 1024 * 1024,
                "maxResolution": "2k",
                "commercialTermsUrl": "https://lingmao.example.com/terms/pro-v1",
            },
            active=True,
        ),
        OfferRecord(
            id="plan-pro-year",
            version="v1",
            type="subscription",
            name="灵猫专业版年卡",
            interval="year",
            currency="CNY",
            price_minor=99900,
            credits=15000,
            expires_in_days=365,
            limits={
                "maxConcurrentJobs": 8,
                "modelIds": ["studio-image", "illustration", "studio-video"],
                "watermark": False,
                "maxCanvasNodes": 500,
                "maxStorageBytes": 50 * 1024 * 1024 * 1024,
                "maxResolution": "2k",
                "commercialTermsUrl": "https://lingmao.example.com/terms/pro-v1",
            },
            active=True,
        ),
        OfferRecord(
            id="pack-500",
            version="v1",
            type="credit_pack",
            name="500 灵猫加油积分包",
            interval=None,
            currency="CNY",
            price_minor=4900,
            credits=500,
            expires_in_days=180,
            limits={},
            active=True,
        ),
    ]
    for o in offers:
        if not db.get(OfferRecord, (o.id, o.version)):
            db.add(o)

    portraits = [
        PortraitCatalogRecord(
            id="portrait-urban-female-01",
            version=1,
            label="都市轻熟女模特 · 林夕",
            preview_asset="/api/v1/ecommerce/portraits/portrait-urban-female-01/preview.png",
            license_version="portrait-license-v1",
            allowed_uses=["try_on", "hand_held", "worn"],
            attributes={
                "poses": ["standing", "walking", "half_body"],
                "scenes": ["studio", "street", "cafe"],
                "skinTones": ["warm_ivory", "natural"],
                "ageGroups": ["20_30"],
                "bodyTypes": ["slim", "regular"],
                "genders": ["female"],
            },
        )
    ]
    for pt in portraits:
        if not db.get(PortraitCatalogRecord, (pt.id, pt.version)):
            db.add(pt)

    db.commit()
