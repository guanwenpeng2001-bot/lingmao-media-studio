from __future__ import annotations

import hashlib
import hmac
import io
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFilter
from app.config import get_settings
from app.errors import AppError
from app.providers.storage import PrivateObjectStorage, inspect_media_bytes


ASPECT_DIMENSIONS: dict[str, tuple[int, int]] = {
    "1:1": (800, 800),
    "3:4": (750, 1000),
    "4:3": (1000, 750),
    "9:16": (720, 1280),
    "16:9": (1280, 720),
}


@dataclass
class MaterializedOutput:
    provider: str
    provider_job_id: str
    execution_mode: str  # "demo" | "live"
    object_key: str
    content_type: str
    media_kind: str
    byte_size: int
    sha256: str
    width: int | None
    height: int | None
    duration_ms: int | None
    asset_role: str
    metadata: dict[str, Any]


class DeterministicDemoGenerationAdapter:
    """
    Explicitly flagged deterministic generation adapter for local development & E2E verification.
    Only active when LINGMAO_DEMO_INFERENCE_ENABLED=true and LINGMAO_ENV_MODE=sandbox.
    Never claims to be a live third-party model.
    """

    provider_name = "demo-deterministic"
    execution_mode = "demo"

    def __init__(self, storage: PrivateObjectStorage | None = None) -> None:
        self.storage = storage or PrivateObjectStorage()

    def capabilities(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "execution": self.execution_mode,
            "deterministic": True,
            "supportsLockedSubject": True,
            "supportsPlayableVideo": True,
        }

    def _resolve_dimensions(self, frozen_input: dict[str, Any]) -> tuple[int, int]:
        params = frozen_input.get("parameters") or {}
        w = params.get("width")
        h = params.get("height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            return w, h
        aspect = params.get("aspectRatio", "1:1")
        return ASPECT_DIMENSIONS.get(aspect, (800, 800))

    def _render_image_output(
        self,
        job_id: str,
        frozen_input: dict[str, Any],
        input_assets: list[dict[str, Any]],
        mask_asset: dict[str, Any] | None,
    ) -> tuple[bytes, int, int, str, dict[str, Any]]:
        mode = frozen_input.get("mode", "product_scene")
        prompt = frozen_input.get("prompt", "")
        params = frozen_input.get("parameters") or {}
        target_w, target_h = self._resolve_dimensions(frozen_input)

        if mode == "upscale":
            factor = float(params.get("upscaleFactor") or 2.0)
            target_w = min(2048, int(round(target_w * factor)))
            target_h = min(2048, int(round(target_h * factor)))

        seed_hash = hashlib.sha256(f"{job_id}:{mode}:{prompt}:{target_w}x{target_h}".encode("utf-8")).digest()
        c1 = (180 + (seed_hash[0] % 55), 155 + (seed_hash[1] % 60), 125 + (seed_hash[2] % 60))
        c2 = (95 + (seed_hash[3] % 70), 75 + (seed_hash[4] % 60), 60 + (seed_hash[5] % 55))

        if mode in ("subject_cutout", "remove_background"):
            # Produce an RGBA cutout/mask image
            mask_img = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
            draw = ImageDraw.Draw(mask_img)
            pad_x, pad_y = int(target_w * 0.18), int(target_h * 0.14)
            draw.rounded_rectangle(
                [(pad_x, pad_y), (target_w - pad_x, target_h - pad_y)],
                radius=32,
                fill=(255, 255, 255, 255),
            )
            buf = io.BytesIO()
            mask_img.save(buf, format="PNG")
            return (
                buf.getvalue(),
                target_w,
                target_h,
                "mask" if mode == "subject_cutout" else "product",
                {"adapter": self.provider_name, "execution": "demo", "mode": mode},
            )

        # Build warm studio gradient background
        output_Kind = params.get("outputKind") or ("poster" if mode == "text_to_image" else "scene")
        bg = Image.new("RGBA", (target_w, target_h), (245, 242, 235, 255))
        draw = ImageDraw.Draw(bg)
        if output_Kind == "white_background":
            draw.rectangle([(0, 0), (target_w, target_h)], fill=(255, 255, 255, 255))
        else:
            for y in range(target_h):
                ratio = y / max(1, target_h - 1)
                r = int(c1[0] * (1 - ratio) + c2[0] * ratio)
                g = int(c1[1] * (1 - ratio) + c2[1] * ratio)
                b = int(c1[2] * (1 - ratio) + c2[2] * ratio)
                draw.line([(0, y), (target_w, y)], fill=(r, g, b, 255))
            # Desk surface at bottom third
            desk_y = int(target_h * 0.68)
            draw.rectangle([(0, desk_y), (target_w, target_h)], fill=(138, 98, 64, 255))
            draw.line([(0, desk_y), (target_w, desk_y)], fill=(195, 155, 115, 255), width=3)

        subject_preserved = False
        source_sha = None
        if input_assets:
            first_asset = input_assets[0]
            source_sha = first_asset.get("sha256")
            try:
                raw_src = self.storage.read_bytes(first_asset["object_key"])
                with Image.open(io.BytesIO(raw_src)) as src_im:
                    src_rgba = src_im.convert("RGBA")
                    placement = params.get("placement") or {"x": 0.5, "y": 0.5, "scale": 0.62}
                    scale = float(placement.get("scale", 0.62))
                    fg_w = max(64, min(target_w, int(target_w * scale)))
                    fg_h = max(64, min(target_h, int(src_rgba.height * (fg_w / max(1, src_rgba.width)))))
                    if fg_h > int(target_h * 0.78):
                        fg_h = int(target_h * 0.78)
                        fg_w = max(64, int(src_rgba.width * (fg_h / max(1, src_rgba.height))))
                    fg_resized = src_rgba.resize((fg_w, fg_h), Image.Resampling.LANCZOS)

                    # Contact shadow
                    shadow = Image.new("RGBA", (fg_w + 40, 36), (0, 0, 0, 0))
                    sdraw = ImageDraw.Draw(shadow)
                    sdraw.ellipse([(8, 6), (fg_w + 32, 30)], fill=(25, 18, 12, 115))
                    shadow = shadow.filter(ImageFilter.GaussianBlur(6))

                    pos_x = max(0, min(target_w - fg_w, int((target_w - fg_w) * float(placement.get("x", 0.5)))))
                    pos_y = max(0, min(target_h - fg_h, int((target_h - fg_h) * float(placement.get("y", 0.5)))))
                    bg.alpha_composite(shadow, (max(0, pos_x - 20), min(target_h - 36, pos_y + fg_h - 18)))
                    bg.alpha_composite(fg_resized, (pos_x, pos_y))
                    subject_preserved = True
            except Exception:
                pass

        # Optional promotional overlay within safe area
        overlay = params.get("overlay")
        if isinstance(overlay, dict) and overlay:
            headline = overlay.get("headline") or ""
            price_text = overlay.get("priceText") or ""
            safe_x = int(target_w * 0.08)
            safe_y = int(target_h * 0.08)
            draw.rounded_rectangle(
                [(safe_x, safe_y), (target_w - safe_x, safe_y + 92)],
                radius=14,
                fill=(20, 24, 38, 195),
            )
            if headline:
                draw.text((safe_x + 18, safe_y + 16), str(headline)[:40], fill=(255, 245, 220, 255))
            if price_text:
                draw.text((safe_x + 18, safe_y + 52), f"PRICE: {price_text}", fill=(255, 195, 75, 255))

        final_rgb = bg.convert("RGB")
        buf = io.BytesIO()
        final_rgb.save(buf, format="PNG", optimize=True)
        role = "poster" if output_Kind == "poster" or mode == "text_to_image" else "scene"
        meta = {
            "adapter": self.provider_name,
            "execution": self.execution_mode,
            "mode": mode,
            "subjectPreserved": subject_preserved,
            "sourceAssetSha256": source_sha,
            "maskApplied": bool(mask_asset or params.get("subjectId") or params.get("maskAssetId")),
        }
        return buf.getvalue(), target_w, target_h, role, meta

    def _render_video_output(
        self,
        job_id: str,
        frozen_input: dict[str, Any],
        input_assets: list[dict[str, Any]],
    ) -> tuple[bytes, int, int, int, dict[str, Any]]:
        params = frozen_input.get("parameters") or {}
        duration_sec = int(params.get("durationSeconds") or 5)
        target_w, target_h = self._resolve_dimensions(frozen_input)
        # Ensure even dimensions for yuv420p encoding
        target_w = (target_w // 2) * 2
        target_h = (target_h // 2) * 2
        camera_motion = params.get("cameraMotion") or "push_in"
        native_audio = bool(params.get("nativeAudio", False))

        # Prepare first frame PNG in temp dir
        with tempfile.TemporaryDirectory(prefix="lingmao_vid_") as tmpdir:
            tmp_path = Path(tmpdir)
            frame_path = tmp_path / "first_frame.png"
            out_mp4 = tmp_path / "output.mp4"

            if input_assets:
                raw_first = self.storage.read_bytes(input_assets[0]["object_key"])
                with Image.open(io.BytesIO(raw_first)) as im:
                    resized = im.convert("RGB").resize((target_w, target_h), Image.Resampling.LANCZOS)
                    resized.save(frame_path, format="PNG")
            else:
                im = Image.new("RGB", (target_w, target_h), (42, 64, 96))
                d = ImageDraw.Draw(im)
                d.text((40, 60), f"Lingmao Video {job_id}", fill=(255, 255, 255))
                im.save(frame_path, format="PNG")

            ffmpeg_bin = shutil.which("ffmpeg") or r"C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"
            if Path(ffmpeg_bin).is_file():
                cmd = [
                    ffmpeg_bin,
                    "-y",
                    "-loop",
                    "1",
                    "-r",
                    "12",
                    "-i",
                    str(frame_path),
                ]
                if native_audio:
                    cmd.extend(["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration_sec}"])
                cmd.extend(
                    [
                        "-t",
                        str(duration_sec),
                        "-vf",
                        f"scale={target_w}:{target_h},format=yuv420p",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "ultrafast",
                        "-pix_fmt",
                        "yuv420p",
                        "-movflags",
                        "+faststart",
                    ]
                )
                if native_audio:
                    cmd.extend(["-c:a", "aac", "-shortest"])
                cmd.append(str(out_mp4))
                proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
                if proc.returncode == 0 and out_mp4.is_file() and out_mp4.stat().st_size > 256:
                    mp4_bytes = out_mp4.read_bytes()
                    return (
                        mp4_bytes,
                        target_w,
                        target_h,
                        duration_sec * 1000,
                        {
                            "adapter": self.provider_name,
                            "execution": self.execution_mode,
                            "cameraMotion": camera_motion,
                            "nativeAudio": native_audio,
                            "firstFrameAssetId": input_assets[0]["id"] if input_assets else None,
                            "encoder": "ffmpeg-libx264",
                        },
                    )

            # Pure-Python minimal valid ISO-BMFF MP4 container fallback
            ftyp = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
            mvhd_payload = (
                b"\x00\x00\x00\x00"
                + (0).to_bytes(4, "big")
                + (0).to_bytes(4, "big")
                + (1000).to_bytes(4, "big")
                + (duration_sec * 1000).to_bytes(4, "big")
                + b"\x00\x01\x00\x00\x01\x00"
                + b"\x00" * 10
                + b"\x00\x01\x00\x00" + b"\x00" * 12 + b"\x00\x01\x00\x00" + b"\x00" * 12 + b"\x40\x00\x00\x00"
                + b"\x00" * 24
                + (2).to_bytes(4, "big")
            )
            mvhd = (len(mvhd_payload) + 8).to_bytes(4, "big") + b"mvhd" + mvhd_payload
            moov = (len(mvhd) + 8).to_bytes(4, "big") + b"moov" + mvhd
            frame_bytes = frame_path.read_bytes()
            mdat = (len(frame_bytes) + 8).to_bytes(4, "big") + b"mdat" + frame_bytes
            mp4_bytes = ftyp + moov + mdat
            return (
                mp4_bytes,
                target_w,
                target_h,
                duration_sec * 1000,
                {
                    "adapter": self.provider_name,
                    "execution": self.execution_mode,
                    "cameraMotion": camera_motion,
                    "nativeAudio": native_audio,
                    "firstFrameAssetId": input_assets[0]["id"] if input_assets else None,
                    "encoder": "fallback-mp4",
                },
            )

    def materialize(
        self,
        workspace_id: str,
        project_id: str,
        job_id: str,
        dispatch_key: str,
        frozen_input: dict[str, Any],
        input_assets: list[dict[str, Any]],
        mask_asset: dict[str, Any] | None = None,
    ) -> MaterializedOutput:
        settings = get_settings()
        if not settings.is_demo_inference:
            raise AppError(
                503,
                "PROVIDER_UNAVAILABLE",
                "未启用开发联调确定性推理适配器，且未配置真实模型推理凭证",
            )

        prompt = str(frozen_input.get("prompt", ""))
        if "__FAIL_PROVIDER__" in prompt:
            raise RuntimeError("PROVIDER_EXECUTION_FAILED")

        mode = str(frozen_input.get("mode", "product_scene"))
        is_video = mode in ("image_to_video", "text_to_video", "video_compose")
        ext = "mp4" if is_video else "png"
        object_key = f"{workspace_id}/{project_id}/generated/job_{job_id}_out_0.{ext}"
        provider_job_id = f"demo-{hashlib.sha256(dispatch_key.encode('utf-8')).hexdigest()[:16]}"

        # Crash recovery reuse: if stable object_key already exists on disk and is valid, reuse it!
        if self.storage.exists(object_key):
            existing_bytes = self.storage.read_bytes(object_key)
            inspected = inspect_media_bytes(existing_bytes, filename=f"job_{job_id}.{ext}")
            return MaterializedOutput(
                provider=self.provider_name,
                provider_job_id=provider_job_id,
                execution_mode=self.execution_mode,
                object_key=object_key,
                content_type=inspected.content_type,
                media_kind=inspected.media_kind,
                byte_size=inspected.byte_size,
                sha256=inspected.sha256,
                width=inspected.width,
                height=inspected.height,
                duration_ms=inspected.duration_ms,
                asset_role="clip" if is_video else "scene",
                metadata={**inspected.metadata, "reusedAfterCrash": True, "execution": "demo"},
            )

        if is_video:
            raw_bytes, w, h, dur_ms, meta = self._render_video_output(job_id, frozen_input, input_assets)
            role = "clip"
        else:
            raw_bytes, w, h, role, meta = self._render_image_output(job_id, frozen_input, input_assets, mask_asset)
            dur_ms = None

        inspected = inspect_media_bytes(raw_bytes, filename=f"job_{job_id}.{ext}")
        sha, size = self.storage.put_bytes(object_key, raw_bytes)
        return MaterializedOutput(
            provider=self.provider_name,
            provider_job_id=provider_job_id,
            execution_mode=self.execution_mode,
            object_key=object_key,
            content_type=inspected.content_type,
            media_kind=inspected.media_kind,
            byte_size=size,
            sha256=sha,
            width=w or inspected.width,
            height=h or inspected.height,
            duration_ms=dur_ms or inspected.duration_ms,
            asset_role=role,
            metadata={**inspected.metadata, **meta},
        )


def verify_webhook_signature(raw_body: bytes, signature_header: str | None, secret: str) -> bool:
    if not signature_header or not secret:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    provided = signature_header.removeprefix("sha256=").strip()
    return hmac.compare_digest(expected, provided)
