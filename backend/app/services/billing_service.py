"""Household-scoped monthly usage, cumulative balances, and conservative cost estimates."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
import hashlib
import math
import re
import threading
import uuid
from typing import Any, Dict, Optional

from google.cloud import firestore
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import settings


HOUSEHOLDS = "households"
USAGE_PERIODS = "usage_periods"
USAGE_EVENTS = "usage_events"
BILLING_STATE = "billing_state"
BILLING_ADJUSTMENTS = "billing_adjustments"
CURRENT_STATE = "current"
SYSTEM = "system"
BILLING_CONFIG = "billing-config"
JST = timezone(timedelta(hours=9))

_client: Optional[firestore.Client] = None
_client_lock = threading.Lock()


class BillingStorageError(RuntimeError):
    """Raised when usage or payment metadata cannot be accessed."""


class MonthlyLimitExceeded(RuntimeError):
    """Raised before AI work when the cumulative outstanding balance reaches its limit."""

    def __init__(self, limit_jpy: int, payment_jpy: int):
        super().__init__("累積未精算残高が利用上限に達したため、新しいレシート解析を停止しています。")
        self.limit_jpy = limit_jpy
        self.payment_jpy = payment_jpy


def _firestore_client() -> firestore.Client:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                try:
                    _client = firestore.Client(database=settings.FIRESTORE_DATABASE)
                except Exception as exc:
                    raise BillingStorageError("利用料金データベースへ接続できませんでした。") from exc
    return _client


def current_period() -> str:
    return datetime.now(JST).strftime("%Y-%m")


def normalize_period(value: str = "") -> str:
    period = str(value or current_period()).strip()
    match = re.fullmatch(r"(20\d{2})-(0[1-9]|1[0-2])", period)
    if not match:
        raise ValueError("対象月はYYYY-MM形式で指定してください。")
    return period


def _as_number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _period_ref(client: firestore.Client, household_id: str, period: str) -> Any:
    return client.collection(HOUSEHOLDS).document(household_id).collection(USAGE_PERIODS).document(period)


def _state_ref(client: firestore.Client, household_id: str) -> Any:
    return client.collection(HOUSEHOLDS).document(household_id).collection(BILLING_STATE).document(CURRENT_STATE)


def _load_or_initialize_storage_state(
    client: firestore.Client,
    household_id: str,
) -> tuple[Dict[str, Any], bool]:
    """Initialize current image bytes once from existing household receipts."""
    state_ref = _state_ref(client, household_id)
    snapshot = state_ref.get()
    if snapshot.exists:
        return snapshot.to_dict() or {}, False

    stored_bytes = 0
    object_names = set()
    receipts = (
        client.collection(HOUSEHOLDS)
        .document(household_id)
        .collection("receipts")
        .stream()
    )
    for receipt_snapshot in receipts:
        receipt = receipt_snapshot.to_dict() or {}
        storage = receipt.get("image_storage") or {}
        if not isinstance(storage, dict):
            continue
        object_name = str(storage.get("object_name") or "").strip()
        if not object_name or object_name in object_names:
            continue
        object_names.add(object_name)
        stored_bytes += max(0, _as_int(storage.get("size_bytes")))

    @firestore.transactional
    def initialize(transaction: Any) -> bool:
        current = state_ref.get(transaction=transaction)
        if current.exists:
            return False
        transaction.set(state_ref, {
            "storage_bytes_current": stored_bytes,
            "metering_started_at": firestore.SERVER_TIMESTAMP,
            "storage_initialized_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        return True

    initialized = bool(initialize(client.transaction()))
    return state_ref.get().to_dict() or {}, initialized


def _payment_config(client: Optional[firestore.Client] = None) -> Dict[str, Any]:
    if not settings.BILLING_ENABLED:
        return {
            "method": "PayPay",
            "recipient": settings.BILLING_PAYPAY_RECIPIENT,
            "qr_configured": False,
        }
    snapshot = (client or _firestore_client()).collection(SYSTEM).document(BILLING_CONFIG).get()
    data = snapshot.to_dict() or {}
    return {
        "method": "PayPay",
        "recipient": str(data.get("paypay_recipient") or settings.BILLING_PAYPAY_RECIPIENT),
        "qr_configured": bool(data.get("paypay_qr_object_name")),
    }


def calculate_costs(
    stats: Dict[str, Any], state: Dict[str, Any],
) -> Dict[str, Any]:
    """Calculate a catalog-rate estimate before shared Google Cloud free tiers."""
    seconds = math.ceil(max(0.0, _as_number(stats.get("cloud_run_ms"))) / 100.0) / 10.0
    requests = max(0, _as_int(stats.get("api_requests")))
    reads = max(0, _as_int(stats.get("firestore_reads_estimate")))
    writes = max(0, _as_int(stats.get("firestore_writes_estimate")))
    deletes = max(0, _as_int(stats.get("firestore_deletes_estimate")))
    uploads = max(0, _as_int(stats.get("gcs_uploads")))
    downloads = max(0, _as_int(stats.get("gcs_downloads")))
    downloaded_bytes = max(0, _as_int(stats.get("gcs_download_bytes")))
    stored_bytes = max(0, _as_int(state.get("storage_bytes_current")))

    ai_usd = max(0.0, _as_number(stats.get("ai_cost_usd")))
    cloud_run_usd = (
        seconds * settings.BILLING_CLOUD_RUN_VCPU * settings.BILLING_CLOUD_RUN_CPU_USD_PER_SECOND
        + seconds * settings.BILLING_CLOUD_RUN_MEMORY_GIB * settings.BILLING_CLOUD_RUN_MEMORY_USD_PER_GIB_SECOND
        + requests / 1_000_000 * settings.BILLING_CLOUD_RUN_REQUEST_USD_PER_MILLION
    )
    firestore_usd = (
        reads / 100_000 * settings.BILLING_FIRESTORE_READ_USD_PER_100K
        + writes / 100_000 * settings.BILLING_FIRESTORE_WRITE_USD_PER_100K
        + deletes / 100_000 * settings.BILLING_FIRESTORE_DELETE_USD_PER_100K
    )
    storage_usd = (
        stored_bytes / (1024 ** 3) * settings.BILLING_GCS_STORAGE_USD_PER_GIB_MONTH
        + uploads / 1000 * settings.BILLING_GCS_CLASS_A_USD_PER_1000
        + downloads / 1000 * settings.BILLING_GCS_CLASS_B_USD_PER_1000
        + downloaded_bytes / (1024 ** 3) * settings.BILLING_GCS_EGRESS_USD_PER_GIB
    )
    exchange_rate = max(0.0, settings.BILLING_USD_JPY_RATE)
    cost_jpy = {
        "ai": round(ai_usd * exchange_rate, 4),
        "cloud_run": round(cloud_run_usd * exchange_rate, 4),
        "firestore": round(firestore_usd * exchange_rate, 4),
        "storage": round(storage_usd * exchange_rate, 4),
    }
    estimated_cost_jpy = round(sum(cost_jpy.values()), 2)
    markup_percent = max(0, settings.BILLING_MARKUP_PERCENT)
    service_fee_jpy = round(estimated_cost_jpy * markup_percent / 100, 2)
    payment_amount_jpy = math.ceil(estimated_cost_jpy + service_fee_jpy)
    return {
        "usd_jpy_rate": exchange_rate,
        "markup_percent": markup_percent,
        "components_jpy": cost_jpy,
        "estimated_cost_jpy": estimated_cost_jpy,
        "service_fee_jpy": service_fee_jpy,
        "payment_amount_jpy": payment_amount_jpy,
    }


def calculate_balance(
    total_charges_jpy: int,
    adjustment_jpy: int,
    usage_limit_jpy: int,
) -> Dict[str, Any]:
    """Apply administrator settlements/waivers to lifetime charges."""
    total_charges = max(0, int(total_charges_jpy))
    adjustment = int(adjustment_jpy)
    outstanding = max(0, total_charges + adjustment)
    limit = max(0, int(usage_limit_jpy))
    used_percent = round(outstanding / limit * 100, 1) if limit else 0.0
    blocked = bool(limit and outstanding >= limit)
    warning = bool(limit and not blocked and used_percent >= 80)
    return {
        "total_charges_jpy": total_charges,
        "adjustment_jpy": adjustment,
        "outstanding_balance_jpy": outstanding,
        "usage_limit_jpy": limit,
        "remaining_jpy": max(0, limit - outstanding) if limit else None,
        "used_percent": used_percent,
        "status": "blocked" if blocked else "warning" if warning else "ok",
        "can_analyze": not blocked,
    }


def _period_cost_map(
    client: firestore.Client,
    household_id: str,
    state: Dict[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """Calculate each tracked month with an end-of-month storage approximation."""
    snapshots = list(
        client.collection(HOUSEHOLDS)
        .document(household_id)
        .collection(USAGE_PERIODS)
        .stream()
    )
    entries = sorted(
        ((snapshot.id, snapshot.to_dict() or {}) for snapshot in snapshots),
        key=lambda item: item[0],
    )
    net_delta = sum(
        max(0, _as_int(stats.get("storage_bytes_added")))
        - max(0, _as_int(stats.get("storage_bytes_deleted")))
        for _, stats in entries
    )
    current_bytes = max(0, _as_int(state.get("storage_bytes_current")))
    running_bytes = max(0, current_bytes - net_delta)
    costs_by_period: Dict[str, Dict[str, Any]] = {}
    for period, stats in entries:
        running_bytes = max(
            0,
            running_bytes
            + max(0, _as_int(stats.get("storage_bytes_added")))
            - max(0, _as_int(stats.get("storage_bytes_deleted"))),
        )
        costs_by_period[period] = calculate_costs(
            stats,
            {"storage_bytes_current": running_bytes},
        )

    active_period = current_period()
    if active_period not in costs_by_period:
        costs_by_period[active_period] = calculate_costs(
            {},
            {"storage_bytes_current": current_bytes},
        )
    return costs_by_period


def _usage_limit(household: Dict[str, Any]) -> int:
    legacy_limit = household.get(
        "billing_monthly_limit_jpy",
        settings.BILLING_DEFAULT_MONTHLY_LIMIT_JPY,
    )
    return max(0, _as_int(household.get("billing_usage_limit_jpy"), _as_int(legacy_limit)))


def get_household_summary(household_id: str, period: str = "") -> Dict[str, Any]:
    period = normalize_period(period)
    if not settings.BILLING_ENABLED:
        household = {"name": "家計簿", "owner_email": ""}
        stats: Dict[str, Any] = {}
        state: Dict[str, Any] = {}
        costs = calculate_costs(stats, state)
        balance = calculate_balance(0, 0, settings.BILLING_DEFAULT_MONTHLY_LIMIT_JPY)
        payment = _payment_config()
    else:
        client = _firestore_client()
        household_snapshot = client.collection(HOUSEHOLDS).document(household_id).get()
        if not household_snapshot.exists:
            raise BillingStorageError("家計簿が見つかりません。")
        household = household_snapshot.to_dict() or {}
        stats = _period_ref(client, household_id, period).get().to_dict() or {}
        state, _ = _load_or_initialize_storage_state(client, household_id)
        costs_by_period = _period_cost_map(client, household_id, state)
        costs = costs_by_period.get(period) or calculate_costs(
            stats,
            {"storage_bytes_current": 0},
        )
        total_charges = sum(
            max(0, _as_int(period_cost.get("payment_amount_jpy")))
            for period_cost in costs_by_period.values()
        )
        balance = calculate_balance(
            total_charges,
            _as_int(state.get("balance_adjustment_jpy")),
            _usage_limit(household),
        )
        balance["updated_at"] = _json_value(state.get("balance_updated_at"))
        balance["updated_by"] = _json_value(state.get("balance_updated_by") or {})
        payment = _payment_config(client)

    # Keep legacy fields temporarily so an old cached frontend fails safely.
    costs["monthly_limit_jpy"] = balance["usage_limit_jpy"]
    costs["remaining_jpy"] = balance["remaining_jpy"]
    costs["used_percent"] = balance["used_percent"]
    costs["status"] = balance["status"]
    costs["can_analyze"] = balance["can_analyze"]
    return {
        "period": period,
        "household": {
            "id": household_id,
            "name": str(household.get("name") or "家計簿"),
            "owner_email": str(household.get("owner_email") or ""),
        },
        "usage": {
            "ai_requests": max(0, _as_int(stats.get("ai_requests"))),
            "ai_failed_requests": max(0, _as_int(stats.get("ai_failed_requests"))),
            "prompt_tokens": max(0, _as_int(stats.get("prompt_tokens"))),
            "completion_tokens": max(0, _as_int(stats.get("completion_tokens"))),
            "reasoning_tokens": max(0, _as_int(stats.get("reasoning_tokens"))),
            "total_tokens": max(0, _as_int(stats.get("total_tokens"))),
            "images": max(0, _as_int(stats.get("images"))),
            "receipts_detected": max(0, _as_int(stats.get("receipts_detected"))),
            "api_requests": max(0, _as_int(stats.get("api_requests"))),
            "storage_bytes_current": max(0, _as_int(state.get("storage_bytes_current"))),
        },
        "costs": costs,
        "balance": balance,
        "payment": payment,
        "estimate_note": "選択月の利用額と、月をまたいで繰り越す未精算残高です。OpenRouter実費と東京リージョン公開単価による無料枠適用前の概算です。",
        "metering_started": _json_value(state.get("metering_started_at")),
    }


def assert_analysis_allowed(household_id: str, requested_images: int = 1) -> None:
    if not settings.BILLING_ENABLED:
        return
    summary = get_household_summary(household_id)
    balance = summary["balance"]
    limit = int(balance["usage_limit_jpy"] or 0)
    reserve = max(0, settings.BILLING_ANALYSIS_RESERVE_JPY) * max(1, int(requested_images))
    projected = int(balance["outstanding_balance_jpy"] or 0) + reserve
    if limit and projected > limit:
        raise MonthlyLimitExceeded(limit, int(balance["outstanding_balance_jpy"] or 0))


def record_ai_usage(
    household_id: str,
    usage: Dict[str, Any],
    *,
    stored_size_bytes: int = 0,
    receipts_detected: int = 0,
    success: bool = True,
) -> bool:
    if not settings.BILLING_ENABLED:
        return False
    client = _firestore_client()
    _load_or_initialize_storage_state(client, household_id)
    period = current_period()
    request_id = str(usage.get("request_id") or uuid.uuid4().hex)
    event_id = hashlib.sha256(f"{household_id}:{request_id}".encode("utf-8")).hexdigest()
    event_ref = client.collection(HOUSEHOLDS).document(household_id).collection(USAGE_EVENTS).document(event_id)
    period_ref = _period_ref(client, household_id, period)
    state_ref = _state_ref(client, household_id)
    stored_bytes = max(0, int(stored_size_bytes))
    event = {
        "period": period,
        "request_id": request_id,
        "model": str(usage.get("model") or settings.DEFAULT_AI_MODEL),
        "prompt_tokens": max(0, _as_int(usage.get("prompt_tokens"))),
        "completion_tokens": max(0, _as_int(usage.get("completion_tokens"))),
        "reasoning_tokens": max(0, _as_int(usage.get("reasoning_tokens"))),
        "total_tokens": max(0, _as_int(usage.get("total_tokens"))),
        "cost_usd": max(0.0, _as_number(usage.get("cost_usd"))),
        "duration_ms": max(0, _as_int(usage.get("duration_ms"))),
        "stored_size_bytes": stored_bytes,
        "receipts_detected": max(0, int(receipts_detected)),
        "success": bool(success),
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    increments = {
        "period": period,
        "ai_requests": firestore.Increment(1),
        "ai_failed_requests": firestore.Increment(0 if success else 1),
        "prompt_tokens": firestore.Increment(event["prompt_tokens"]),
        "completion_tokens": firestore.Increment(event["completion_tokens"]),
        "reasoning_tokens": firestore.Increment(event["reasoning_tokens"]),
        "total_tokens": firestore.Increment(event["total_tokens"]),
        "ai_cost_usd": firestore.Increment(event["cost_usd"]),
        "cloud_run_ms": firestore.Increment(event["duration_ms"]),
        "api_requests": firestore.Increment(1),
        "images": firestore.Increment(1),
        "receipts_detected": firestore.Increment(event["receipts_detected"]),
        "gcs_uploads": firestore.Increment(1 if stored_bytes else 0),
        "storage_bytes_added": firestore.Increment(stored_bytes),
        "firestore_writes_estimate": firestore.Increment(3),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }

    @firestore.transactional
    def apply(transaction: Any) -> bool:
        if event_ref.get(transaction=transaction).exists:
            return False
        transaction.set(event_ref, event)
        transaction.set(period_ref, increments, merge=True)
        transaction.set(state_ref, {
            "storage_bytes_current": firestore.Increment(stored_bytes),
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        return True

    try:
        return bool(apply(client.transaction()))
    except Exception as exc:
        raise BillingStorageError("AI利用料金を記録できませんでした。") from exc


def record_cloud_activity(
    household_id: str,
    *,
    duration_ms: int = 0,
    firestore_reads: int = 0,
    firestore_writes: int = 0,
    firestore_deletes: int = 0,
    gcs_downloads: int = 0,
    gcs_download_bytes: int = 0,
    storage_bytes_delta: int = 0,
) -> None:
    if not settings.BILLING_ENABLED:
        return
    client = _firestore_client()
    state_initialized_now = False
    if storage_bytes_delta:
        _, state_initialized_now = _load_or_initialize_storage_state(client, household_id)
    period_ref = _period_ref(client, household_id, current_period())
    batch = client.batch()
    batch.set(period_ref, {
        "period": current_period(),
        "cloud_run_ms": firestore.Increment(max(0, int(duration_ms))),
        "api_requests": firestore.Increment(1),
        "firestore_reads_estimate": firestore.Increment(max(0, int(firestore_reads))),
        "firestore_writes_estimate": firestore.Increment(max(0, int(firestore_writes)) + 1),
        "firestore_deletes_estimate": firestore.Increment(max(0, int(firestore_deletes))),
        "gcs_downloads": firestore.Increment(max(0, int(gcs_downloads))),
        "gcs_download_bytes": firestore.Increment(max(0, int(gcs_download_bytes))),
        "storage_bytes_deleted": firestore.Increment(max(0, -int(storage_bytes_delta))),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    if storage_bytes_delta and not state_initialized_now:
        batch.set(_state_ref(client, household_id), {
            "storage_bytes_current": firestore.Increment(int(storage_bytes_delta)),
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
    try:
        batch.commit()
    except Exception as exc:
        raise BillingStorageError("Cloud利用量を記録できませんでした。") from exc


def update_household_billing(
    household_id: str,
    *,
    usage_limit_jpy: Optional[int] = None,
    outstanding_balance_jpy: Optional[int] = None,
    note: str = "",
    admin: Any = None,
) -> Dict[str, Any]:
    """Update cumulative limit and/or set current outstanding balance."""
    if usage_limit_jpy is None and outstanding_balance_jpy is None:
        raise ValueError("利用上限または未精算残高を指定してください。")
    if not settings.BILLING_ENABLED:
        return get_household_summary(household_id)
    client = _firestore_client()
    household_ref = client.collection(HOUSEHOLDS).document(household_id)
    if not household_ref.get().exists:
        raise BillingStorageError("家計簿が見つかりません。")
    before = get_household_summary(household_id)
    previous_balance = before["balance"]
    state_ref = _state_ref(client, household_id)
    actor = {
        "subject": str(getattr(admin, "subject", "") or ""),
        "email": str(getattr(admin, "email", "") or ""),
    }
    batch = client.batch()

    if usage_limit_jpy is not None:
        batch.set(household_ref, {
            "billing_usage_limit_jpy": max(0, int(usage_limit_jpy)),
            "billing_updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

    if outstanding_balance_jpy is not None:
        desired = max(0, int(outstanding_balance_jpy))
        adjustment = desired - int(previous_balance["total_charges_jpy"])
        batch.set(state_ref, {
            "balance_adjustment_jpy": adjustment,
            "balance_updated_at": firestore.SERVER_TIMESTAMP,
            "balance_updated_by": actor,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        adjustment_ref = (
            household_ref.collection(BILLING_ADJUSTMENTS).document(uuid.uuid4().hex)
        )
        batch.set(adjustment_ref, {
            "previous_outstanding_balance_jpy": int(previous_balance["outstanding_balance_jpy"]),
            "new_outstanding_balance_jpy": desired,
            "total_charges_jpy_at_update": int(previous_balance["total_charges_jpy"]),
            "balance_adjustment_jpy": adjustment,
            "note": str(note or "").strip()[:200],
            "updated_by": actor,
            "created_at": firestore.SERVER_TIMESTAMP,
        })
    try:
        batch.commit()
    except Exception as exc:
        raise BillingStorageError("料金設定を更新できませんでした。") from exc
    return get_household_summary(household_id)


def list_household_summaries(period: str = "") -> Dict[str, Any]:
    period = normalize_period(period)
    if not settings.BILLING_ENABLED:
        return {"period": period, "households": []}
    summaries = []
    for snapshot in _firestore_client().collection(HOUSEHOLDS).stream():
        summaries.append(get_household_summary(snapshot.id, period))
    summaries.sort(key=lambda item: item["balance"]["outstanding_balance_jpy"], reverse=True)
    return {
        "period": period,
        "households": summaries,
        "total_estimated_cost_jpy": round(sum(item["costs"]["estimated_cost_jpy"] for item in summaries), 2),
        "total_payment_amount_jpy": sum(item["costs"]["payment_amount_jpy"] for item in summaries),
        "total_outstanding_balance_jpy": sum(
            item["balance"]["outstanding_balance_jpy"] for item in summaries
        ),
    }


def upload_payment_qr(image_bytes: bytes) -> Dict[str, Any]:
    if not settings.GCS_BUCKET_NAME:
        raise BillingStorageError("Cloud Storageが設定されていません。")
    if not image_bytes or len(image_bytes) > 5_000_000:
        raise BillingStorageError("QR画像は5MB以下で指定してください。")
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source)
            image.load()
            image = image.convert("RGB")
            if max(image.size) > 1600:
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            output = BytesIO()
            image.save(output, format="PNG", optimize=True)
            normalized = output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise BillingStorageError("QR画像を読み込めませんでした。") from exc

    object_name = "billing/payment/paypay-qr.png"
    try:
        from google.cloud import storage
        storage.Client().bucket(settings.GCS_BUCKET_NAME).blob(object_name).upload_from_string(
            normalized, content_type="image/png"
        )
        _firestore_client().collection(SYSTEM).document(BILLING_CONFIG).set({
            "paypay_qr_object_name": object_name,
            "paypay_recipient": settings.BILLING_PAYPAY_RECIPIENT,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
    except BillingStorageError:
        raise
    except Exception as exc:
        raise BillingStorageError("PayPay QR画像を保存できませんでした。") from exc
    return _payment_config()


def download_payment_qr() -> tuple[bytes, str]:
    if not settings.BILLING_ENABLED or not settings.GCS_BUCKET_NAME:
        raise BillingStorageError("PayPay QR画像はまだ登録されていません。")
    config = _firestore_client().collection(SYSTEM).document(BILLING_CONFIG).get().to_dict() or {}
    object_name = str(config.get("paypay_qr_object_name") or "")
    if not object_name.startswith("billing/payment/"):
        raise BillingStorageError("PayPay QR画像はまだ登録されていません。")
    try:
        from google.cloud import storage
        content = storage.Client().bucket(settings.GCS_BUCKET_NAME).blob(object_name).download_as_bytes()
        return content, "image/png"
    except Exception as exc:
        raise BillingStorageError("PayPay QR画像を読み込めませんでした。") from exc
