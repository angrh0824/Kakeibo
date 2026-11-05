"""Household-level settings: categories, budgets and recurring (fixed) expenses.

Stored at ``households/{household_id}/config/settings`` so every member of the
household sees and edits the same budget. Missing documents fall back to the
defaults below, which match the categories the app has always used.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from google.cloud import firestore

from app.auth import AuthenticatedUser
from app.models import FALLBACK_CATEGORY, CategoryReassign, CategorySetting, HouseholdSettingsWrite
from app.services.shared_storage import (
    SharedStorageError,
    _audit_user,
    _firestore_client,
    _json_value,
    _receipts_collection,
    ensure_legacy_family_migrated,
)

logger = logging.getLogger(__name__)
HOUSEHOLDS = "households"
CONFIG_COLLECTION = "config"
SETTINGS_DOCUMENT = "settings"
SETTINGS_VERSION = 1

DEFAULT_CATEGORIES: List[Dict[str, Any]] = [
    {"name": "食費", "color": "c1", "budget": 0},
    {"name": "日用品", "color": "c2", "budget": 0},
    {"name": "衛生用品", "color": "c3", "budget": 0},
    {"name": "交際費", "color": "c4", "budget": 0},
    {"name": "住居・光熱", "color": "c5", "budget": 0},
    {"name": "通信・サブスク", "color": "c7", "budget": 0},
    {"name": FALLBACK_CATEGORY, "color": "gray", "budget": 0},
]


class SettingsNotFoundError(SharedStorageError):
    """Raised when a category to rename does not exist."""


def default_settings() -> Dict[str, Any]:
    payload = HouseholdSettingsWrite(categories=[CategorySetting(**c) for c in DEFAULT_CATEGORIES])
    return {**payload.model_dump(mode="json"), "version": SETTINGS_VERSION, "is_default": True}


def _settings_reference(household_id: str) -> Any:
    if not household_id:
        raise SharedStorageError("家計簿が選択されていません。")
    return (
        _firestore_client()
        .collection(HOUSEHOLDS)
        .document(household_id)
        .collection(CONFIG_COLLECTION)
        .document(SETTINGS_DOCUMENT)
    )


def _normalize_stored(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a stored document so older or hand-edited data never breaks the UI."""
    try:
        payload = HouseholdSettingsWrite.model_validate({
            "categories": data.get("categories") or DEFAULT_CATEGORIES,
            "monthly_budget": data.get("monthly_budget") or 0,
            "recurring": data.get("recurring") or [],
        })
    except Exception:
        logger.warning("Stored household settings were invalid; using defaults", exc_info=True)
        return default_settings()
    result = payload.model_dump(mode="json")
    result.update({
        "version": SETTINGS_VERSION,
        "is_default": False,
        "updated_at": _json_value(data.get("updated_at")),
        "updated_by": data.get("updated_by") or {},
    })
    return result


def get_household_settings(household_id: str) -> Dict[str, Any]:
    try:
        snapshot = _settings_reference(household_id).get()
        if not snapshot.exists:
            return default_settings()
        return _normalize_stored(snapshot.to_dict() or {})
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Household settings read failed", exc_info=True)
        raise SharedStorageError("家計簿の設定を読み込めませんでした。") from exc


def category_names(household_id: str) -> List[str]:
    """Category names for AI classification. Falls back to defaults on any error."""
    try:
        return [c["name"] for c in get_household_settings(household_id)["categories"]]
    except Exception:
        logger.warning("Falling back to default categories for AI analysis", exc_info=True)
        return [c["name"] for c in DEFAULT_CATEGORIES]


def save_household_settings(
    household_id: str, payload: HouseholdSettingsWrite, user: AuthenticatedUser
) -> Dict[str, Any]:
    try:
        reference = _settings_reference(household_id)
        data = payload.model_dump(mode="json")
        data.update({
            "version": SETTINGS_VERSION,
            "household_id": household_id,
            "updated_at": firestore.SERVER_TIMESTAMP,
            "updated_by": _audit_user(user),
        })
        reference.set(data)
        return _normalize_stored(reference.get().to_dict() or {})
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Household settings save failed", exc_info=True)
        raise SharedStorageError("家計簿の設定を保存できませんでした。") from exc


def _reassigned_settings(current: Dict[str, Any], change: CategoryReassign) -> HouseholdSettingsWrite:
    categories = [dict(c) for c in current["categories"]]
    names = [c["name"] for c in categories]
    if change.from_name not in names:
        raise SettingsNotFoundError(f"カテゴリ「{change.from_name}」が見つかりません。")
    if change.from_name == FALLBACK_CATEGORY:
        raise SharedStorageError(f"「{FALLBACK_CATEGORY}」は変更・削除できません。")

    if change.to_name in names:
        # 統合: 移動元を消し、予算は移動先へ合算する。
        source = next(c for c in categories if c["name"] == change.from_name)
        target = next(c for c in categories if c["name"] == change.to_name)
        target["budget"] = int(target.get("budget") or 0) + int(source.get("budget") or 0)
        categories = [c for c in categories if c["name"] != change.from_name]
    else:
        for category in categories:
            if category["name"] == change.from_name:
                category["name"] = change.to_name

    recurring = []
    for expense in current.get("recurring") or []:
        entry = dict(expense)
        if entry.get("category") == change.from_name:
            entry["category"] = change.to_name
        recurring.append(entry)

    return HouseholdSettingsWrite.model_validate({
        "categories": categories,
        "monthly_budget": current.get("monthly_budget") or 0,
        "recurring": recurring,
    })


def reassign_category(household_id: str, change: CategoryReassign, user: AuthenticatedUser) -> Dict[str, Any]:
    """Rename a category, or merge it into another existing one, across all receipts."""
    try:
        ensure_legacy_family_migrated(household_id)
        current = get_household_settings(household_id)
        next_settings = _reassigned_settings(current, change)

        client = _firestore_client()
        batch = client.batch()
        pending_writes = 0
        affected_receipts = 0
        for snapshot in _receipts_collection(household_id).stream():
            data = snapshot.to_dict() or {}
            items = list(data.get("items") or [])
            changed = False
            for item in items:
                if str(item.get("category") or "") == change.from_name:
                    item["category"] = change.to_name
                    changed = True
            if not changed:
                continue
            batch.update(snapshot.reference, {
                "items": items,
                "updated_at": firestore.SERVER_TIMESTAMP,
                "updated_by": _audit_user(user),
            })
            pending_writes += 1
            affected_receipts += 1
            if pending_writes >= 400:
                batch.commit()
                batch = client.batch()
                pending_writes = 0
        if pending_writes:
            batch.commit()

        saved = save_household_settings(household_id, next_settings, user)
        return {"settings": saved, "affected_receipts": affected_receipts}
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Category reassignment failed", exc_info=True)
        raise SharedStorageError("カテゴリを変更できませんでした。") from exc
