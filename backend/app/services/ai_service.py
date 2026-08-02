import json
import httpx
import logging
from typing import Dict, Any, List
from app.config import settings

logger = logging.getLogger(__name__)

# Gemma用のプロンプト（docs/02_Gemma最適化プロンプト.md に基づく）
GEMMA_SYSTEM_PROMPT = """
あなたは日本のレシート解析に特化した高度なAIアテンダントです。
入力されたレシートのテキストまたは画像情報から、以下のJSONフォーマットで厳密に構造化データを出力してください。

【出力フォーマット】
{
  "store": "店舗名",
  "date": "YYYY-MM-DDTHH:MM:SS",
  "total": 1234,
  "confidence": 0.95,
  "items": [
    {
      "name": "商品名",
      "price": 100,
      "quantity": 1,
      "category": "食費"
    }
  ]
}

【カテゴリの定義】
- 食費: 食品、飲料、生鮮食品、お菓子、お弁当など
- 日用品: 洗剤、ティッシュ、ポリ袋、文房具など
- 衛生用品: マスク、薬、歯ブラシ、ハンドソープなど
- 交際費: ギフト、外食、イベント費用など
- その他: 上記に該当しないもの
"""

async def analyze_receipt_text(ocr_text: str) -> Dict[str, Any]:
    """
    OCRで得られたテキストを Gemma (OpenRouter) に渡して構造化JSONを取得する関数
    """
    if not settings.OPENROUTER_API_KEY:
        logger.warning("OPENROUTER_API_KEY が未設定のため、デモ用レスポンスを返します。")
        return get_mock_result(ocr_text)

    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://kakeibo-ver2.local",
        "X-Title": "NextGen Kakeibo App",
        "Content-Type": "json/application"
    }

    payload = {
        "model": settings.DEFAULT_AI_MODEL,
        "messages": [
            {"role": "system", "content": GEMMA_SYSTEM_PROMPT},
            {"role": "user", "content": f"以下のレシートテキストから情報を抽出してください:\n\n{ocr_text}"}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception as e:
        logger.error(f"AI 解析失敗: {e}")
        return get_mock_result(ocr_text)

def get_mock_result(ocr_text: str = "") -> Dict[str, Any]:
    """APIキー未設定時やエラー時のモックフォールバック関数"""
    return {
        "store": "マルエイストア (モック)",
        "date": "2026-08-02T18:30:00",
        "total": 1280,
        "confidence": 0.92,
        "items": [
            {"name": "牛乳 1L", "price": 228, "quantity": 1, "category": "食費"},
            {"name": "食パン 6枚切", "price": 168, "quantity": 1, "category": "食費"},
            {"name": "トイレットペーパー 12R", "price": 398, "quantity": 1, "category": "日用品"},
            {"name": "緑茶 500ml", "price": 150, "quantity": 2, "category": "食費"}
        ]
    }
