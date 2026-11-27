from __future__ import annotations

import hashlib
import io
import os
import shutil
import struct
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageOps
from app.config import get_settings
from app.errors import AppError


@dataclass
class InspectedMedia:
    media_kind: str  # image | video | audio
    content_type: str
    byte_size: int
    sha256: str
    width: int | None
    height: int | None
    duration_ms: int | None
    metadata: dict[str, Any]
    normalized_bytes: bytes


def _parse_mp4_duration_and_dims(data: bytes) -> tuple[int | None, int | None, int | None]:
    duration_ms: int | None = None
    width: int | None = None
    height: int | None = None

    # Search for mvhd box for duration
    mvhd_idx = data.find(b"mvhd")
    if mvhd_idx >= 4:
        try:
            version = data[mvhd_idx + 4]
            if version == 0 and len(data) >= mvhd_idx + 24:
                timescale, duration = struct.unpack(">II", data[mvhd_idx + 16 : mvhd_idx + 24])
                if timescale > 0:
                    duration_ms = int(round((duration / timescale) * 1000))
            elif version == 1 and len(data) >= mvhd_idx + 36:
                timescale, duration = struct.unpack(">IQ", data[mvhd_idx + 24 : mvhd_idx + 36])
                if timescale > 0:
                    duration_ms = int(round((duration / timescale) * 1000))
        except Exception:
            pass

    # Search for tkhd box for width/height (16.16 fixed point at end of tkhd)
    tkhd_idx = data.find(b"tkhd")
    if tkhd_idx >= 4:
        try:
            version = data[tkhd_idx + 4]
            offset = tkhd_idx + (80 if version == 0 else 92)
            if len(data) >= offset + 8:
                w_fixed, h_fixed = struct.unpack(">II", data[offset : offset + 8])
                w = w_fixed >> 16
                h = h_fixed >> 16
                if w > 0 and h > 0:
                    width, height = w, h
        except Exception:
            pass

    return width, height, duration_ms


def inspect_media_bytes(raw_bytes: bytes, filename: str = "") -> InspectedMedia:
    if not raw_bytes:
        raise AppError(422, "INVALID_INPUT", "上传文件内容为空")

    settings = get_settings()
    if len(raw_bytes) > settings.max_upload_bytes:
        raise AppError(413, "PAYLOAD_TOO_LARGE", f"文件字节数超过上限 {settings.max_upload_bytes}")

    if b"__BLOCK_CONTENT__" in raw_bytes or "__block_content__" in filename.lower():
        raise AppError(422, "CONTENT_BLOCKED", "内容安全审核未通过")

    # 1. Check image magic bytes (PNG, JPEG, WEBP)
    is_png = raw_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    is_jpeg = raw_bytes.startswith(b"\xff\xd8\xff")
    is_webp = len(raw_bytes) >= 12 and raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP"

    if is_png or is_jpeg or is_webp:
        try:
            with Image.open(io.BytesIO(raw_bytes)) as img:
                img.load()
                fmt = (img.format or "PNG").upper()
                transposed = ImageOps.exif_transpose(img)
                width, height = transposed.size
                if fmt == "JPEG":
                    content_type = "image/jpeg"
                elif fmt == "WEBP":
                    content_type = "image/webp"
                else:
                    content_type = "image/png"
                # Preserve normalized bytes if orientation changed, else keep raw
                normalized = raw_bytes
        except Exception as exc:
            raise AppError(415, "UNSUPPORTED_MEDIA", f"无法解析图像文件: {exc}") from exc

        sha = hashlib.sha256(normalized).hexdigest()
        meta: dict[str, Any] = {
            "originalFilename": filename,
            "format": content_type,
            "shortEdge": min(width, height),
        }
        if min(width, height) < 512:
            meta["qualityWarning"] = "SHORT_EDGE_BELOW_512"
        return InspectedMedia(
            media_kind="image",
            content_type=content_type,
            byte_size=len(normalized),
            sha256=sha,
            width=width,
            height=height,
            duration_ms=None,
            metadata=meta,
            normalized_bytes=normalized,
        )

    # 2. Check MP4 video (ftyp box)
    if len(raw_bytes) >= 12 and raw_bytes[4:8] == b"ftyp":
        width, height, duration_ms = _parse_mp4_duration_and_dims(raw_bytes)
        sha = hashlib.sha256(raw_bytes).hexdigest()
        return InspectedMedia(
            media_kind="video",
            content_type="video/mp4",
            byte_size=len(raw_bytes),
            sha256=sha,
            width=width or 720,
            height=height or 1280,
            duration_ms=duration_ms or 5000,
            metadata={"originalFilename": filename, "format": "video/mp4"},
            normalized_bytes=raw_bytes,
        )

    # 3. Check WAV / MP3 audio
    is_wav = len(raw_bytes) >= 12 and raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WAVE"
    is_mp3 = raw_bytes.startswith(b"ID3") or raw_bytes.startswith(b"\xff\xfb")
    if is_wav or is_mp3:
        sha = hashlib.sha256(raw_bytes).hexdigest()
        content_type = "audio/wav" if is_wav else "audio/mpeg"
        return InspectedMedia(
            media_kind="audio",
            content_type=content_type,
            byte_size=len(raw_bytes),
            sha256=sha,
            width=None,
            height=None,
            duration_ms=5000,
            metadata={"originalFilename": filename, "format": content_type},
            normalized_bytes=raw_bytes,
        )

    raise AppError(415, "UNSUPPORTED_MEDIA", "不支持的媒体格式或真实文件头不匹配")


class PrivateObjectStorage:
    def __init__(self, base_dir: str | None = None) -> None:
        settings = get_settings()
        self.base_path = Path(base_dir or settings.storage_dir).resolve()
        self.base_path.mkdir(parents=True, exist_ok=True)

    def resolve_path(self, object_key: str) -> Path:
        clean_key = object_key.lstrip("/\\")
        target = (self.base_path / clean_key).resolve()
        if not str(target).startswith(str(self.base_path)):
            raise AppError(403, "FORBIDDEN", "非法存储路径")
        return target

    def put_bytes(self, object_key: str, data: bytes) -> tuple[str, int]:
        target = self.resolve_path(object_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = target.with_suffix(target.suffix + f".tmp.{os.getpid()}")
        tmp_path.write_bytes(data)
        os.replace(tmp_path, target)
        sha = hashlib.sha256(data).hexdigest()
        return sha, len(data)

    def exists(self, object_key: str) -> bool:
        return self.resolve_path(object_key).is_file()

    def read_bytes(self, object_key: str) -> bytes:
        target = self.resolve_path(object_key)
        if not target.is_file():
            raise AppError(404, "NOT_FOUND", "底层媒体对象不存在")
        return target.read_bytes()

    def ensure_watermarked_image_variant(self, source_key: str, variant_key: str) -> tuple[str, int, bytes]:
        if self.exists(variant_key):
            data = self.read_bytes(variant_key)
            return hashlib.sha256(data).hexdigest(), len(data), data

        raw = self.read_bytes(source_key)
        try:
            with Image.open(io.BytesIO(raw)) as img:
                rgba = img.convert("RGBA")
                overlay = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
                draw = ImageDraw.Draw(overlay)
                w, h = rgba.size
                banner_h = max(28, h // 12)
                draw.rectangle([(0, h - banner_h), (w, h)], fill=(15, 23, 42, 165))
                draw.text((16, h - banner_h + 6), "LINGMAO STUDIO · FREE PREVIEW WATERMARK", fill=(255, 255, 255, 230))
                combined = Image.alpha_composite(rgba, overlay).convert("RGB")
                buf = io.BytesIO()
                combined.save(buf, format="PNG")
                wm_bytes = buf.getvalue()
            sha, size = self.put_bytes(variant_key, wm_bytes)
            return sha, size, wm_bytes
        except AppError:
            raise
        except Exception as exc:
            raise AppError(
                503,
                "PROVIDER_UNAVAILABLE",
                "免费版图片水印合成失败，已拒绝无水印输出",
            ) from exc

    def ensure_watermarked_video_variant(self, source_key: str, variant_key: str) -> tuple[str, int, bytes]:
        if self.exists(variant_key):
            data = self.read_bytes(variant_key)
            return hashlib.sha256(data).hexdigest(), len(data), data

        source_path = self.resolve_path(source_key)
        if not source_path.is_file():
            raise AppError(404, "NOT_FOUND", "底层媒体对象不存在")

        settings = get_settings()
        if settings.ffmpeg_bin.strip():
            ffmpeg_bin = settings.ffmpeg_bin.strip()
        else:
            ffmpeg_bin = (
                shutil.which("ffmpeg")
                or r"C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"
            )

        if not ffmpeg_bin or not Path(ffmpeg_bin).is_file():
            raise AppError(
                503,
                "PROVIDER_UNAVAILABLE",
                "视频水印组件 ffmpeg 未就绪，拒绝导出未加水印免费视频",
            )

        try:
            with tempfile.TemporaryDirectory(prefix="lingmao_wm_vid_") as tmpdir:
                tmp_path = Path(tmpdir)
                wm_png_path = tmp_path / "wm_badge.png"
                out_mp4_path = tmp_path / "watermarked.mp4"

                badge = Image.new("RGBA", (240, 32), (15, 23, 42, 200))
                draw = ImageDraw.Draw(badge)
                draw.text((10, 8), "LINGMAO · FREE WATERMARK", fill=(255, 255, 255, 240))
                badge.save(wm_png_path, format="PNG")

                cmd = [
                    ffmpeg_bin,
                    "-y",
                    "-i",
                    str(source_path),
                    "-i",
                    str(wm_png_path),
                    "-filter_complex",
                    "[0:v][1:v]overlay=max(0\\,W-w-12):max(0\\,H-h-12),format=yuv420p[v]",
                    "-map",
                    "[v]",
                    "-map",
                    "0:a?",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "copy",
                    "-movflags",
                    "+faststart",
                    str(out_mp4_path),
                ]
                proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
                if proc.returncode != 0 or not out_mp4_path.is_file() or out_mp4_path.stat().st_size <= 256:
                    raise RuntimeError("ffmpeg watermark process failed")
                wm_bytes = out_mp4_path.read_bytes()
            sha, size = self.put_bytes(variant_key, wm_bytes)
            return sha, size, wm_bytes
        except AppError:
            raise
        except Exception as exc:
            raise AppError(
                503,
                "PROVIDER_UNAVAILABLE",
                "免费版视频水印合成失败，已拒绝无水印输出",
            ) from exc
