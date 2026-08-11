"""Firestore-backed shared receipt persistence for the family workspace."""

from __future__ import annotations

from datetime import datetime
import logging
import threading
import uuid
from typing import Any, Dict, List, Optional

from google.cloud import firestore

from app.auth import AuthenticatedUser
from app.config import settings
from app.models import ItemMasterUpdate, ReceiptWrite
from app.services.image_storage import ImageStorageError, delete_receipt_image

logger = logging.getLogger(__name__)
COLLECTION_NAME = "receipts"
_client: Optional[firestore.Client] = None
_client_lock = threading.Lock()


class SharedStorageError(RuntimeError):
    """Raised when Firestore cannot complete a shared-data operation."""


class ReceiptNotFoundError(SharedStorageError):
    """Raised when a receipt document does not exist."""


def _firestore_client() -> firestore.Client:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                try:
                    _client = firestore.Client(database=settings.FIRESTORE_DATABASE)
                except Exception as exc:
                    raise SharedStorageError("共有データベースへ接続できませんでした。") from exc
    return _client


def _audit_user(user: AuthenticatedUser) -> Dict[str, str]:
    return {"email": user.email, "name": user.name or user.email}


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _receipt_from_snapshot(snapshot: Any) -> Dict[str, Any]:
    data = snapshot.to_dict() or {}
    data["id"] = snapshot.id
    return _json_value(data)


def list_receipts() -> List[Dict[str, Any]]:
    try:
        snapshots = _firestore_client().collection(COLLECTION_NAME).stream()
        receipts = [_receipt_from_snapshot(snapshot) for snapshot in snapshots]
        return sorted(receipts, key=lambda receipt: str(receipt.get("date") or ""), reverse=True)
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Firestore receipt listing failed", exc_info=True)
        raise SharedStorageError("共有レシートを読み込めませんでした。") from exc


def get_receipt(receipt_id: str) -> Dict[str, Any]:
    try:
        snapshot = _firestore_client().collection(COLLECTION_NAME).document(receipt_id).get()
        if not snapshot.exists:
            raise ReceiptNotFoundError("レシートが見つかりません。")
        return _receipt_from_snapshot(snapshot)
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Firestore receipt read failed", exc_info=True)
        raise SharedStorageError("共有レシートを読み込めませんでした。") from exc


def create_receipt(payload: ReceiptWrite, user: AuthenticatedUser) -> Dict[str, Any]:
    try:
        client = _firestore_client()
        document = client.collection(COLLECTION_NAME).document(uuid.uuid4().hex)
        data = payload.model_dump(mode="json")
        data.update({
            "created_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
            "created_by": _audit_user(user),
            "updated_by": _audit_user(user),
        })
        document.set(data)
        return _receipt_from_snapshot(document.get())
    except Exception as exc:
        logger.error("Firestore receipt creation failed", exc_info=True)
        raise SharedStorageError("共有レシートを登録できませんでした。") from exc


def update_receipt(receipt_id: str, payload: ReceiptWrite, user: AuthenticatedUser) -> Dict[str, Any]:
    try:
        client = _firestore_client()
        document = client.collection(COLLECTION_NAME).document(receipt_id)
        existing = document.get()
        if not existing.exists:
            raise ReceiptNotFoundError("レシートが見つかりません。")

        previous = existing.to_dict() or {}
        data = payload.model_dump(mode="json")
        if data.get("image_storage") is None and previous.get("image_storage"):
            data["image_storage"] = previous["image_storage"]
        data.update({
            "updated_at": firestore.SERVER_TIMESTAMP,
            "updated_by": _audit_user(user),
        })
        document.set(data, merge=True)
        return _receipt_from_snapshot(document.get())
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Firestore receipt update failed", exc_info=True)
        raise SharedStorageError("共有レシートを更新できませんでした。") from exc


def _image_is_referenced(object_name: str) -> bool:
    for snapshot in _firestore_client().collection(COLLECTION_NAME).stream():
        storage = (snapshot.to_dict() or {}).get("image_storage") or {}
        if storage.get("object_name") == object_name:
            return True
    return False


def delete_receipt(receipt_id: str) -> Dict[str, Any]:
    try:
        client = _firestore_client()
        document = client.collection(COLLECTION_NAME).document(receipt_id)
        snapshot = document.get()
        if not snapshot.exists:
            raise ReceiptNotFoundError("レシートが見つかりません。")
        receipt = _receipt_from_snapshot(snapshot)
        document.delete()

        image_deleted = False
        image_storage = receipt.get("image_storage") or {}
        object_name = str(image_storage.get("object_name") or "")
        if object_name and not _image_is_referenced(object_name):
            try:
                image_deleted = delete_receipt_image(object_name)
            except ImageStorageError:
                logger.warning("Receipt was deleted but its orphan image could not be removed", exc_info=True)

        return {"receipt": receipt, "image_deleted": image_deleted}
    except SharedStorageError:
        raise
    except Exception as exc:
        logger.error("Firestore receipt deletion failed", exc_info=True)
        raise SharedStorageError("共有レシートを削除できませんでした。") from exc


def update_item_master(payload: ItemMasterUpdate, user: AuthenticatedUser) -> int:
    try:
        client = _firestore_client()
        batch = client.batch()
        pending_writes = 0
        affected_receipts = 0

        for snapshot in client.collection(COLLECTION_NAME).stream():
            data = snapshot.to_dict() or {}
            items = list(data.get("items") or [])
            changed = False
            for item in items:
                if str(item.get("name") or "") == payload.old_name:
                    item["name"] = payload.new_name
                    item["category"] = payload.category
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
        return affected_receipts
    except Exception as exc:
        logger.error("Firestore item master update failed", exc_info=True)
        raise SharedStorageError("商品マスタを更新できませんでした。") from exc