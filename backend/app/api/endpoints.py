from fastapi import APIRouter, UploadFile, File, HTTPException
from app.services.ocr_service import extract_text_from_image
from app.services.ai_service import analyze_receipt_text
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/receipts/analyze")
async def analyze_receipt(file: UploadFile = File(...)):
    """
    レシート画像を受け取り、OCRテキスト認識とGemma AI構造化を順に実行して
    Human-in-the-loop確認フォーム用のJSON結果を返却します。
    """
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="画像ファイル(PNG/JPEG)をアップロードしてください。")

    try:
        image_bytes = await file.read()
        
        # 1. OCR 文字認識
        ocr_text = await extract_text_from_image(image_bytes)
        
        # 2. Gemma AI 構造化データ抽出
        result = await analyze_receipt_text(ocr_text)
        
        return {
            "success": True,
            "filename": file.filename,
            "data": result
        }
    except Exception as e:
        logger.error(f"レシート解析中にエラー発生: {e}")
        raise HTTPException(status_code=500, detail=f"解析エラー: {str(e)}")

@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "次世代家計簿 API"}
