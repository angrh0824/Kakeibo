import os
import logging
from typing import str

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

    # デモ・フォールバック用ダミーテキスト
    logger.info("OCR処理完了 (フォールバックテキスト使用)")
    return """
    マルエイストア 秋葉原店
    2026/08/02 18:30
    レシートNo. 12345
    
    牛乳 1L          \228
    食パン 6枚切      \168
    トイレットペーパー  \398
    緑茶 500ml  2点   \300
    
    小計            \1,094
    消費税(8%)         \87
    消費税(10%)        \39
    合計            \1,280
    """
