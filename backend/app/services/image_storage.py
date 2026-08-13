"""Receipt image compression and optional Google Cloud Storage integration."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
import hashlib
import re
import uuid
from typing import Any, Dict, Optional, Tuple

from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import settings


class ImageStorageError(RuntimeError):
    """Raised when receipt image compression or Cloud Storage access fails."""


def compress_receipt_image(image_bytes: bytes) -> Tuple[bytes, str]:
    """Normalize a receipt image to a smaller, OCR-friendly JPEG."""
    if not image_bytes:
        raise ImageStorageError("画像データが空です。")
    if len(image_bytes) > settings.RECEIPT_IMAGE_MAX_UPLOAD_BYTES:
        raise ImageStorageError(
            f"画像サイズが上限（{settings.RECEIPT_IMAGE_MAX_UPLOAD_BYTES // 1000000}MB）を超えています。"
        )

    try:
        with Image.open(BytesIO(image_bytes)) as source:
            if source.width * source.height > 50_000_000:
                raise ImageStorageError("画像の解像度が高すぎます。")

            image = ImageOps.exif_transpose(source)
            image.load()
            if "A" in image.getbands():
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, "white")
                background.paste(rgba, mask=rgba.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")

            max_dimension = max(640, int(settings.RECEIPT_IMAGE_MAX_DIMENSION))
            image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)

            quality = min(95, max(45, int(settings.RECEIPT_IMAGE_JPEG_QUALITY)))
            encoded = b""
            for _ in range(8):
                output = BytesIO()
                image.save(
                    output,
                    format="JPEG",
                    quality=quality,
                    optimize=True,
                    progressive=True,
                )
                encoded = output.getvalue()
                if len(encoded) <= settings.RECEIPT_IMAGE_MAX_BYTES:
                    break

                if quality > 52:
                    quality = max(45, quality - 8)
                    continue

                width, height = image.size
                if max(width, height) <= 640:
                    break
                resized = (max(640, int(width * 0.85)), max(640, int(height * 0.85)))
                image = image.resize(resized, Image.Resampling.LANCZOS)

            return encoded, "image/jpeg"
    except ImageStorageError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageStorageError("JPEG画像を読み込めませんでした。") from exc


def _storage_client() -> Any:
    try:
        from google.cloud import storage
    except ImportError as exc:
        raise ImageStorageError(
            "google-cloud-storageがインストールされていません。"
        ) from exc

    try:
        return storage.Client()
    except Exception as exc:
        raise ImageStorageError(
            "Google Cloud Storageの認証に失敗しました。"
        ) from exc


def _prefix() -> str:
    return (settings.GCS_RECEIPT_PREFIX or "receipts").strip("/") or "receipts"


def _validate_object_name(object_name: str) -> str:
    normalized = str(object_name or "").strip().lstrip("/")
    prefix = _prefix()
    if not normalized.startswith(f"{prefix}/"):
        raise ImageStorageError("画像参照先が不正です。")
    return normalized


def upload_receipt_image(image_bytes: bytes, household_id: str) -> Optional[Dict[str, Any]]:
    """Upload a compressed image under the selected household namespace."""
    if not settings.GCS_BUCKET_NAME:
        return None

    safe_household_id = re.sub(r"[^a-zA-Z0-9_-]", "-", household_id).strip("-")
    if not safe_household_id:
        raise ImageStorageError("画像を保存する家計簿が選択されていません。")
    digest = hashlib.sha256(image_bytes).hexdigest()[:16]
    object_name = (
        f"{_prefix()}/{safe_household_id}/{datetime.now(timezone.utc):%Y/%m}/"
        f"{digest}-{uuid.uuid4().hex}.jpg"
    )
    try:
        client = _storage_client()
        blob = client.bucket(settings.GCS_BUCKET_NAME).blob(object_name)
        blob.upload_from_string(image_bytes, content_type="image/jpeg")
    except ImageStorageError:
        raise
    except Exception as exc:
        raise ImageStorageError("Google Cloud Storageへの画像保存に失敗しました。") from exc

    return {
        "provider": "gcs",
        "bucket": settings.GCS_BUCKET_NAME,
        "object_name": object_name,
        "content_type": "image/jpeg",
        "size_bytes": len(image_bytes),
        "sha256": digest,
    }


def create_receipt_image_signed_url(object_name: str) -> str:
    """Create a short-lived read URL for a stored receipt image."""
    object_name = _validate_object_name(object_name)
    if not settings.GCS_BUCKET_NAME:
        raise ImageStorageError("GCS_BUCKET_NAMEが設定されていません。")

    try:
        client = _storage_client()
        blob = client.bucket(settings.GCS_BUCKET_NAME).blob(object_name)
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=max(60, settings.GCS_SIGNED_URL_TTL_SECONDS)),
            method="GET",
        )
    except ImageStorageError:
        raise
    except Exception as exc:
        raise ImageStorageError("画像閲覧用URLの発行に失敗しました。") from exc


def delete_receipt_image(object_name: str) -> bool:
    """Delete a stored receipt image, returning False when storage is disabled."""
    object_name = _validate_object_name(object_name)
    if not settings.GCS_BUCKET_NAME:
        return False

    try:
        client = _storage_client()
        client.bucket(settings.GCS_BUCKET_NAME).blob(object_name).delete()
        return True
    except ImageStorageError:
        raise
    except Exception as exc:
        raise ImageStorageError("Google Cloud Storage上の画像削除に失敗しました。") from exc

def download_receipt_image(object_name: str) -> Tuple[bytes, str]:
    """Download a private receipt image for authenticated API streaming."""
    object_name = _validate_object_name(object_name)
    if not settings.GCS_BUCKET_NAME:
        raise ImageStorageError("GCS_BUCKET_NAMEが設定されていません。")

    try:
        client = _storage_client()
        blob = client.bucket(settings.GCS_BUCKET_NAME).blob(object_name)
        content = blob.download_as_bytes()
        return content, blob.content_type or "image/jpeg"
    except ImageStorageError:
        raise
    except Exception as exc:
        raise ImageStorageError("レシート画像を読み込めませんでした。") from exc
