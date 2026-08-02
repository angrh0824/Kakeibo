from fastapi import APIRouter, UploadFile, File, HTTPException
from app.services.ai_service import analyze_receipt_image
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/receipts/analyze")
async def analyze_receipt(file: UploadFile = File(...)):
    """
    レシート画像を受け取り、Gemma マルチモーダル AI で画像から直接店舗名・日付・品目・合計を抽出します。
    """
    content_type = file.content_type or "image/jpeg"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="画像ファイル(PNG/JPEG)をアップロードしてください。")

    try:
        image_bytes = await file.read()
        
        # マルチモーダル AI 直接画像解析
        result = await analyze_receipt_image(image_bytes, content_type=content_type)
        
        return {
            "success": True,
            "filename": file.filename,
            "data": result
        }
    except Exception as e:
        logger.error(f"レシート画像解析エラー: {e}")
        raise HTTPException(status_code=500, detail=f"解析エラー: {str(e)}")

@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "次世代家計簿 API"}
