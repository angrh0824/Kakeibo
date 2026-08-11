import os
import logging

logger = logging.getLogger(__name__)

async def extract_text_from_image(image_bytes: bytes) -> str:
    """
    レシート画像から文字(OCR)を抽出するサービス関数。
    Google Cloud Vision API または Tesseract 5 を呼び出します。
    """
    # Google Cloud Vision API が利用可能な場合
    if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
        try:
            from google.cloud import vision
            client = vision.ImageAnnotatorClient()
            image = vision.Image(content=image_bytes)
            response = client.text_detection(image=image)
            texts = response.text_annotations
            if texts:
                return texts[0].description
        except Exception as e:
            logger.error(f"Google Cloud Vision OCR エラー: {e}")

    raise RuntimeError("利用可能なOCRエンジンが設定されていません。")
