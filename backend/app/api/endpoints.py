import asyncio
from typing import List, Optional

from fastapi import APIRouter, UploadFile, File, HTTPException
from app.services.ai_service import ReceiptAnalysisError, analyze_receipt_image
from app.services.image_storage import ImageStorageError, compress_receipt_image, upload_receipt_image
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_IMAGES_PER_REQUEST = 10


@router.post("/receipts/analyze")
async def analyze_receipts(
    files: Optional[List[UploadFile]] = File(default=None),
    file: Optional[UploadFile] = File(default=None),
):
    """
    レシート画像を画像ごとにAI解析し、画像内の複数レシートも個別に返します。

    `files` に同じフィールド名で複数ファイルを渡せます。既存の単一 `file` も受け付けます。
    """
    uploaded_files = list(files or [])
    if file is not None and hasattr(file, "filename") and hasattr(file, "read"): uploaded_files.append(file)
    if not uploaded_files:
        raise HTTPException(status_code=400, detail="画像ファイルを1枚以上アップロードしてください。")
    if len(uploaded_files) > MAX_IMAGES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=f"一度にアップロードできる画像は{MAX_IMAGES_PER_REQUEST}枚までです。",
        )

    invalid_files = [
        upload.filename or "(ファイル名なし)"
        for upload in uploaded_files
        if not (upload.content_type or "").startswith("image/")
    ]
    if invalid_files:
        raise HTTPException(
            status_code=400,
            detail=f"画像ファイルのみアップロードできます: {', '.join(invalid_files)}",
        )

    try:
        images = []
        receipts = []
        for upload in uploaded_files:
            content_type = upload.content_type or "image/jpeg"
            image_bytes = await upload.read()
            original_size_bytes = len(image_bytes)
            compressed_bytes, compressed_content_type = compress_receipt_image(image_bytes)
            result = await analyze_receipt_image(compressed_bytes, content_type=compressed_content_type)
            image_receipts = result.get("receipts", [])
            stored_image = await asyncio.to_thread(upload_receipt_image, compressed_bytes)

            for receipt in image_receipts:
                receipt["source_filename"] = upload.filename or "(ファイル名なし)"

            for receipt in image_receipts:
                if stored_image:
                    receipt["image_storage"] = stored_image

            images.append({
                "filename": upload.filename,
                "receipts": image_receipts,
                "image_storage": stored_image,
                "original_size_bytes": original_size_bytes,
                "stored_size_bytes": len(compressed_bytes),
            })
            receipts.extend(image_receipts)

        return {
            "success": True,
            "images": images,
            "receipts": receipts,
            "total_images": len(images),
            "total_receipts": len(receipts),
            # Keep the previous single-file response available for existing clients.
            "data": receipts[0] if len(receipts) == 1 else None,
        }
    except ImageStorageError as e:
        logger.warning("レシート画像の圧縮・保存に失敗しました: %s", e)
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ReceiptAnalysisError as e:
        logger.warning("レシート画像解析を完了できませんでした: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:
        logger.error("レシート画像解析エラー: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="レシート画像解析中に予期しないエラーが発生しました。") from e

@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "次世代家計簿 API"}
