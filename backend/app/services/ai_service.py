import base64
import json
import httpx
import logging
from typing import Any, Dict, List
from app.config import settings

logger = logging.getLogger(__name__)


class ReceiptAnalysisError(RuntimeError):
    """Raised when the configured vision model cannot analyze a receipt image."""


# 日本のスーパー・コンビニレシート特有の記法に完全対応した超高精度プロンプト
JAPANESE_RECEIPT_PROMPT = """
あなたは日本のレシート解析および会計データ抽出の最高峰エキスパートAIです。
提供されたレシート画像を隅々まで正確に読み取り、画像内にあるすべてのレシートを個別に抽出してください。以下の厳密なルールに従ってJSONを出力してください。

【複数レシートの扱い】
- 画像内にレシートが複数枚ある場合、見えている各レシートを必ず別々の要素として抽出してください。別のレシートの品目や合計を混ぜないでください。
- レシートは画像の上から下、同じ高さでは左から右の順で並べてください。
- レシートが重なっていて文字や合計が見えない場合は、推測で補わず、読める情報だけを抽出してください。
- レシートが1枚も見つからない場合は、`receipts` に空配列を返してください。

【厳密な抽出ルール】
1. 店舗名 (store):
   - レシート最上部のロゴや店名（例: "maruetsu 鹿島田店", "セブンイレブン" など）を正確に抽出してください。

2. 日付 (date):
   - レシートに記載されている購入日時（例: "2025年 9月27日 (土) 18:46" -> "2025-09-27T18:46:00"）をISO8601形式で抽出してください。

3. 最終税込合計金額 (total):
   - 「小計」や「外税%商品金額計」ではなく、消費税が含まれた最終支払額の【合計】金額（例: "合計 ¥2,676" なら 2676）を整数値で抽出してください。

4. 消費税と金額整合 (最重要):
   - `subtotal` に税抜商品の小計、`tax` に消費税の合計、`taxes` に税率ごとの税額（例: [{"rate": 8, "amount": 80}, {"rate": 10, "amount": 120}])を整数で抽出してください。読み取れない場合は 0 または空配列にしてください。
   - `items[].price` は必ず「税額を適切に配賦した後の税込の1個あたり実効単価」としてください。レシート上で商品価格と消費税が別表示でも、税抜価格のまま返してはいけません。
   - 税率が複数ある場合は、各商品の税区分・税率に応じて税額を商品へ配賦してください。税額の1円未満の端数は、対象商品の金額比で配賦し、最後に最も金額の大きい対象商品で調整してください。
   - 商品価格がすでに税込表示（内税）の場合は税額を二重加算しないでください。
   - `sum(items[].price * items[].quantity)` が、印字された税込の `total` と必ず一致するようにしてください。割引・クーポン・ポイント値引き後の実支払額を使い、支払方法やお釣りは含めないでください。

5. 購入品目リスト (items):
   - 商品名から "外8", "外10", "内8" などの税区分マークや記号は除去してください。
   - 「自動割引 30%∇ -277」や「組合せ値引(額) -8」などの割引・値引き行がある場合：
     - 直前の該当商品の単価・価格に割引を反映させるか、または正しく引いた後の金額を設定してください。
     - 例: 「豚ロース生姜焼 923円」の直下に「自動割引 30%∇ -277」がある場合、この商品の実質価格は 646円 (923 - 277) です。
     - 例: 「ひとり鍋 2個 358円」の直下に「組合せ値引(額) -8」がある場合、この商品の実質価格は 350円 (358 - 8) です。
   - 「小計」「消費税等」「合計」「お買物券」「クレ金額」などの集計・決済行は items に含めないでください。
   - 各商品のカテゴリは [食費, 日用品, 衛生用品, 交際費, その他] から適切なものを1つ割り当ててください。

【出力フォーマット (JSONのみ)】
{"receipts": [{
  "store": "maruetsu 鹿島田店",
  "date": "2025-09-27T18:46:00",
  "total": 2676,
  "confidence": 0.98,
  "subtotal": 2478,
  "tax": 198,
  "taxes": [{"rate": 8, "amount": 198}],
  "items": [
    {
      "name": "ひとり鍋",
      "price": 175,
      "quantity": 2,
      "category": "食費"
    },
    {
      "name": "玉ねぎ",
      "price": 158,
      "quantity": 1,
      "category": "食費"
    },
    {
      "name": "金つぶたまご醤油",
      "price": 88,
      "quantity": 1,
      "category": "食費"
    },
    {
      "name": "ＴＶえびいか",
      "price": 298,
      "quantity": 1,
      "category": "食費"
    },
    {
      "name": "豚ロース生姜焼 (値引後)",
      "price": 646,
      "quantity": 1,
      "category": "食費"
    },
    {
      "name": "国産若鶏もも肉",
      "price": 938,
      "quantity": 1,
      "category": "食費"
    }
  ]
}]}

必ず余計な解説やMarkdown装飾（```jsonなど）を含めず、ValidなJSONオブジェクトのみを返してください。
"""

async def analyze_receipt_image(image_bytes: bytes, content_type: str = "image/jpeg") -> Dict[str, List[Dict[str, Any]]]:
    """
    レシート画像を Base64 に変換し、OpenRouter 上の高精度ビジョンAIに送信して構造化データを取得する関数
    """
    if not settings.OPENROUTER_API_KEY:
        raise ReceiptAnalysisError("OPENROUTER_API_KEY is not configured")

    base64_image = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{content_type};base64,{base64_image}"

    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://kakeibo-ver2.local",
        "X-Title": "NextGen Kakeibo App",
        "Content-Type": "application/json"
    }

    # OpenRouterで使用するモデル。DEFAULT_AI_MODELで指定したモデルをそのまま使用する。
    target_model = settings.DEFAULT_AI_MODEL

    payload = {
        "model": target_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": JAPANESE_RECEIPT_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_url}
                    }
                ]
            }
        ],
    }

    # GPT-5.6系列ではプロバイダ既定の推論設定を使い、その他のモデルには低いtemperatureを指定する。
    if not target_model.startswith("openai/gpt-5.6"):
        payload["temperature"] = 0.1

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            res_json = response.json()
            raw_content = res_json["choices"][0]["message"].get("content")
            if isinstance(raw_content, list):
                raw_content = "\n".join(
                    part.get("text", "") for part in raw_content if isinstance(part, dict)
                )
            if not isinstance(raw_content, str) or not raw_content.strip():
                raise ReceiptAnalysisError("AIから解析結果が返りませんでした。")
            raw_content = raw_content.strip()

            # Markdownコードブロック除去
            if raw_content.startswith("```"):
                lines = raw_content.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                raw_content = "\n".join(lines).strip()

            try:
                parsed_result = json.loads(raw_content)
            except json.JSONDecodeError:
                start = raw_content.find("{")
                end = raw_content.rfind("}")
                if start < 0 or end <= start:
                    raise ReceiptAnalysisError("AIの応答をJSONとして解釈できませんでした。")
                try:
                    parsed_result = json.loads(raw_content[start:end + 1])
                except json.JSONDecodeError as parse_error:
                    raise ReceiptAnalysisError("AIの応答をJSONとして解釈できませんでした。") from parse_error
            return normalize_receipt_batch(parsed_result)

    except ReceiptAnalysisError:
        raise
    except httpx.HTTPStatusError as e:
        logger.error("OpenRouter APIエラー: %s", e, exc_info=True)
        raise ReceiptAnalysisError(
            f"AI解析サービスがエラーを返しました（HTTP {e.response.status_code}）。"
        ) from e
    except httpx.HTTPError as e:
        logger.error("OpenRouter APIへの接続に失敗しました: %s", e, exc_info=True)
        raise ReceiptAnalysisError("AI解析サービスに接続できませんでした。") from e
    except Exception as e:
        logger.error("AI画像解析に失敗しました: %s", e, exc_info=True)
        raise ReceiptAnalysisError("AIから返った解析結果を読み取れませんでした。") from e

def _to_int(value: Any, default: int = 0) -> int:
    """Convert common receipt number formats (¥1,234 / 1234.0) to yen."""
    if value is None or isinstance(value, bool):
        return default
    try:
        if isinstance(value, str):
            value = value.replace(",", "").replace("¥", "").replace("円", "").replace("%", "").strip()
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _explicit_tax_total(candidate: Dict[str, Any]) -> Any:
    """Return a declared tax amount, or None when the model did not provide one."""
    for key in ("tax", "tax_total", "tax_amount"):
        if key in candidate and candidate.get(key) not in (None, ""):
            return _to_int(candidate.get(key))
    taxes = candidate.get("taxes")
    if isinstance(taxes, list):
        amounts = [_to_int(tax.get("amount")) for tax in taxes if isinstance(tax, dict)]
        if amounts:
            return sum(amounts)
    return None


def _distribute_delta(delta: int, weights: List[int]) -> List[int]:
    """Distribute a yen delta proportionally with deterministic largest-remainder rounding."""
    if not weights or delta == 0:
        return [0] * len(weights)
    positive_weights = [max(0, weight) for weight in weights]
    if not any(positive_weights):
        positive_weights = [1] * len(weights)
    magnitude = abs(delta)
    weight_total = sum(positive_weights)
    allocations = [(magnitude * weight) // weight_total for weight in positive_weights]
    remainders = [
        (magnitude * weight) % weight_total for weight in positive_weights
    ]
    remaining = magnitude - sum(allocations)
    for index in sorted(range(len(weights)), key=lambda i: (remainders[i], positive_weights[i]), reverse=True)[:remaining]:
        allocations[index] += 1
    sign = 1 if delta > 0 else -1
    return [sign * allocation for allocation in allocations]


def _reconcile_receipt_items(candidate: Dict[str, Any], raw_items: List[Any]) -> tuple[List[Dict[str, Any]], bool]:
    """Make the displayed item line totals add up to the printed tax-inclusive total."""
    items: List[Dict[str, Any]] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        quantity = max(1, _to_int(raw_item.get("quantity"), 1))
        price = max(0, _to_int(raw_item.get("price"), 0))
        fallback_line_total = price * quantity
        line_total = max(0, _to_int(raw_item.get("line_total"), fallback_line_total))
        item = {
            "name": str(raw_item.get("name") or "").strip(),
            "price": price,
            "quantity": quantity,
            "category": str(raw_item.get("category") or "その他"),
            "line_total": line_total,
        }
        if raw_item.get("tax_rate") not in (None, ""):
            item["tax_rate"] = _to_int(raw_item.get("tax_rate"))
        items.append(item)

    total = _to_int(candidate.get("total"))
    if total <= 0 or not items:
        return items, False

    current_total = sum(item["line_total"] for item in items)
    delta = total - current_total
    if delta == 0:
        return items, False

    explicit_tax = _explicit_tax_total(candidate)
    subtotal = _to_int(candidate.get("subtotal"))
    plausible_delta = abs(delta) <= max(500, int(total * 0.25))
    if explicit_tax is None and subtotal <= 0 and not plausible_delta:
        return items, False
    if delta < -current_total:
        return items, False

    weights = []
    for item in items:
        tax_rate = item.get("tax_rate")
        weights.append(0 if tax_rate == 0 else item["line_total"])
    allocations = _distribute_delta(delta, weights)
    for item, allocation in zip(items, allocations):
        target_line_total = max(0, item["line_total"] + allocation)
        item["line_total"] = target_line_total
        item["price"] = max(0, int(round(target_line_total / item["quantity"])))
    return items, True


def normalize_receipt_batch(result: Any) -> Dict[str, List[Dict[str, Any]]]:
    """Normalize AI responses to a consistent batch format."""
    if isinstance(result, dict) and isinstance(result.get("receipts"), list):
        candidates = result["receipts"]
    elif isinstance(result, dict):
        # Support the previous single-receipt response format.
        candidates = [result]
    else:
        candidates = []

    receipts: List[Dict[str, Any]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue

        raw_items = candidate.get("items", [])
        if not isinstance(raw_items, list):
            raw_items = []
        items, tax_reconciled = _reconcile_receipt_items(candidate, raw_items)
        raw_taxes = candidate.get("taxes", [])
        taxes = [
            {"rate": _to_int(tax.get("rate")), "amount": _to_int(tax.get("amount"))}
            for tax in raw_taxes if isinstance(tax, dict)
        ] if isinstance(raw_taxes, list) else []

        receipts.append({
            "store": str(candidate.get("store") or ""),
            "date": str(candidate.get("date") or ""),
            "total": _to_int(candidate.get("total")),
            "subtotal": _to_int(candidate.get("subtotal")),
            "tax": _explicit_tax_total(candidate) or 0,
            "taxes": taxes,
            "tax_reconciled": tax_reconciled,
            "confidence": float(candidate.get("confidence") or 0),
            "items": items,
        })

    return {"receipts": receipts}
