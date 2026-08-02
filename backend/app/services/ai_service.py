import base64
import json
import httpx
import logging
from typing import Dict, Any
from app.config import settings

logger = logging.getLogger(__name__)

GEMMA_MULTIMODAL_PROMPT = """
あなたは日本のレシート解析に特化した高度なAIアテンダントです。
提供されたレシートの画像から文字とレイアウトを直接読み取り、以下のJSONフォーマットで厳密に構造化データを出力してください。

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

【注意事項】
- 日付はレシートに印刷されている購入日時(年-月-日T時:分:秒)を正確に抽出してください。
- カテゴリは [食費, 日用品, 衛生用品, 交際費, その他] から最も適切なものを選択してください。
- 合計金額(total)はレシートの最終支払合計額(税込)を設定してください。
- JSON以外の説明文やMarkdownの装飾(```json ... ```)は一切含めず、純粋なJSONのみを出力してください。
"""

async def analyze_receipt_image(image_bytes: bytes, content_type: str = "image/jpeg") -> Dict[str, Any]:
    """
    レシート画像を Base64 に変換し、Gemma / Vision LLM (OpenRouter) に直接送信して構造化データを取得する関数
    """
    if not settings.OPENROUTER_API_KEY:
        logger.warning("OPENROUTER_API_KEY が未設定のため、デモ用レスポンスを返します。")
        return get_mock_result()

    base64_image = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{content_type};base64,{base64_image}"

    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://kakeibo-ver2.local",
        "X-Title": "NextGen Kakeibo App",
        "Content-Type": "application/json"
    }

    # 画像マルチモーダル対応ペイロード
    payload = {
        "model": settings.DEFAULT_AI_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": GEMMA_MULTIMODAL_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_url}
                    }
                ]
            }
        ],
        "temperature": 0.1
    }

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            res_json = response.json()
            raw_content = res_json["choices"][0]["message"]["content"].strip()

            # コードブロック記法 ```json の除去処理
            if raw_content.startswith("```"):
                lines = raw_content.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                raw_content = "\n".join(lines).strip()

            parsed_result = json.loads(raw_content)
            return parsed_result

    except Exception as e:
        logger.error(f"AI 画像直接解析失敗: {e}")
        return get_mock_result()

def get_mock_result() -> Dict[str, Any]:
    """フォールバック用関数"""
    return {
        "store": "解析エラー (再試行してください)",
        "date": "2026-08-02T12:00:00",
        "total": 0,
        "confidence": 0.5,
        "items": []
    }
