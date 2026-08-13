import asyncio
import logging
import time
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response

from app.auth import AuthenticatedUser, require_authorized_user
from app.config import settings
from app.models import HouseholdBillingLimitUpdate, HouseholdInviteCreate, ItemMasterUpdate, ReceiptWrite
from app.services.ai_service import ReceiptAnalysisError, analyze_receipt_image
from app.services.billing_service import (
    BillingStorageError,
    MonthlyLimitExceeded,
    assert_analysis_allowed,
    download_payment_qr,
    get_household_summary,
    list_household_summaries,
    record_ai_usage,
    record_cloud_activity,
    set_household_limit,
    upload_payment_qr,
)
from app.services.image_storage import (
    ImageStorageError,
    compress_receipt_image,
    download_receipt_image,
    upload_receipt_image,
)
from app.services.shared_storage import (
    ReceiptNotFoundError,
    SharedStorageError,
    create_receipt,
    delete_receipt,
    get_receipt,
    list_receipts,
    update_item_master,
    update_receipt,
)
from app.services.tenant_service import (
    TenantStorageError,
    approve_signup,
    ban_user,
    cancel_invitation,
    invite_household_member,
    list_household_members,
    list_platform_users,
    list_signup_requests,
    remove_household_member,
    require_household_owner,
    require_platform_admin,
    unban_user,
)

logger = logging.getLogger(__name__)
router = APIRouter()
MAX_IMAGES_PER_REQUEST = 10


async def _record_activity_safely(household_id: str, **usage: int) -> None:
    try:
        await asyncio.to_thread(record_cloud_activity, household_id, **usage)
    except BillingStorageError:
        logger.warning("Cloud利用量を記録できませんでした。", exc_info=True)


async def _record_ai_usage_safely(household_id: str, usage: dict, **details: object) -> None:
    if not usage:
        return
    try:
        await asyncio.to_thread(
            record_ai_usage,
            household_id,
            usage,
            **details,
        )
    except BillingStorageError:
        logger.warning("AI利用料金を記録できませんでした。", exc_info=True)


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))


@router.post("/receipts/analyze")
async def analyze_receipts(
    user: AuthenticatedUser = Depends(require_authorized_user),
    files: Optional[List[UploadFile]] = File(default=None),
    file: Optional[UploadFile] = File(default=None),
):
    """画像ごとにAI解析し、選択中の家計簿領域へ画像を保存します。"""
    uploaded_files = list(files or [])
    if file is not None and hasattr(file, "filename") and hasattr(file, "read"):
        uploaded_files.append(file)
    if not uploaded_files:
        raise HTTPException(status_code=400, detail="画像ファイルを1枚以上アップロードしてください。")
    if len(uploaded_files) > MAX_IMAGES_PER_REQUEST:
        raise HTTPException(status_code=400, detail=f"一度にアップロードできる画像は{MAX_IMAGES_PER_REQUEST}枚までです。")
    invalid_files = [
        upload.filename or "(ファイル名なし)"
        for upload in uploaded_files
        if not (upload.content_type or "").startswith("image/")
    ]
    if invalid_files:
        raise HTTPException(status_code=400, detail=f"画像ファイルのみアップロードできます: {', '.join(invalid_files)}")

    try:
        active_usage: dict = {}
        await asyncio.to_thread(assert_analysis_allowed, user.household_id, len(uploaded_files))
        images = []
        receipts = []
        for upload in uploaded_files:
            image_bytes = await upload.read()
            original_size_bytes = len(image_bytes)
            compressed_bytes, compressed_content_type = compress_receipt_image(image_bytes)
            result = await analyze_receipt_image(
                compressed_bytes,
                content_type=compressed_content_type,
                household_id=user.household_id,
            )
            active_usage = result.get("_usage", {})
            image_receipts = result.get("receipts", [])
            stored_image = await asyncio.to_thread(
                upload_receipt_image, compressed_bytes, user.household_id
            )
            for receipt in image_receipts:
                receipt["source_filename"] = upload.filename or "(ファイル名なし)"
                if stored_image:
                    receipt["image_storage"] = stored_image
            images.append({
                "filename": upload.filename,
                "receipts": image_receipts,
                "image_storage": stored_image,
                "original_size_bytes": original_size_bytes,
                "stored_size_bytes": len(compressed_bytes),
            })
            receipts.extend(image_receipts)
            await _record_ai_usage_safely(
                user.household_id,
                active_usage,
                stored_size_bytes=int((stored_image or {}).get("size_bytes") or 0),
                receipts_detected=len(image_receipts),
                success=True,
            )
            active_usage = {}
        return {
            "success": True,
            "images": images,
            "receipts": receipts,
            "total_images": len(images),
            "total_receipts": len(receipts),
            "data": receipts[0] if len(receipts) == 1 else None,
        }
    except ImageStorageError as exc:
        if active_usage:
            await _record_ai_usage_safely(user.household_id, active_usage, success=False)
        logger.warning("レシート画像の圧縮・保存に失敗しました: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ReceiptAnalysisError as exc:
        await _record_ai_usage_safely(user.household_id, exc.usage, success=False)
        logger.warning("レシート画像解析を完了できませんでした: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except MonthlyLimitExceeded as exc:
        raise HTTPException(status_code=429, detail=f"{exc} 上限: ¥{exc.limit_jpy:,}") from exc
    except BillingStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("レシート画像解析エラー: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="レシート画像解析中に予期しないエラーが発生しました。") from exc


@router.get("/receipts")
async def get_shared_receipts(user: AuthenticatedUser = Depends(require_authorized_user)):
    started_at = time.perf_counter()
    try:
        receipts = await asyncio.to_thread(list_receipts, user.household_id)
        await _record_activity_safely(user.household_id, duration_ms=_elapsed_ms(started_at), firestore_reads=len(receipts))
        return {"success": True, "receipts": receipts, "count": len(receipts), "household_id": user.household_id}
    except SharedStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/receipts", status_code=201)
async def create_shared_receipt(payload: ReceiptWrite, user: AuthenticatedUser = Depends(require_authorized_user)):
    started_at = time.perf_counter()
    try:
        receipt = await asyncio.to_thread(create_receipt, user.household_id, payload, user)
        await _record_activity_safely(user.household_id, duration_ms=_elapsed_ms(started_at), firestore_reads=1, firestore_writes=1)
        return {"success": True, "receipt": receipt}
    except SharedStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/receipts/{receipt_id}")
async def update_shared_receipt(receipt_id: str, payload: ReceiptWrite, user: AuthenticatedUser = Depends(require_authorized_user)):
    started_at = time.perf_counter()
    try:
        receipt = await asyncio.to_thread(update_receipt, user.household_id, receipt_id, payload, user)
        await _record_activity_safely(user.household_id, duration_ms=_elapsed_ms(started_at), firestore_reads=2, firestore_writes=1)
        return {"success": True, "receipt": receipt}
    except ReceiptNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SharedStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete("/receipts/{receipt_id}")
async def delete_shared_receipt(receipt_id: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    started_at = time.perf_counter()
    try:
        result = await asyncio.to_thread(delete_receipt, user.household_id, receipt_id)
        deleted_bytes = int((((result.get("receipt") or {}).get("image_storage") or {}).get("size_bytes")) or 0)
        await _record_activity_safely(user.household_id, duration_ms=_elapsed_ms(started_at), firestore_reads=2, firestore_deletes=1, storage_bytes_delta=-deleted_bytes if result.get("image_deleted") else 0)
        return {"success": True, **result}
    except ReceiptNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SharedStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/receipts/{receipt_id}/image")
async def get_shared_receipt_image(receipt_id: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    started_at = time.perf_counter()
    try:
        receipt = await asyncio.to_thread(get_receipt, user.household_id, receipt_id)
        image_storage = receipt.get("image_storage") or {}
        object_name = str(image_storage.get("object_name") or "")
        if not object_name:
            raise HTTPException(status_code=404, detail="このレシートには画像がありません。")
        image_bytes, content_type = await asyncio.to_thread(download_receipt_image, object_name)
        await _record_activity_safely(user.household_id, duration_ms=_elapsed_ms(started_at), firestore_reads=1, gcs_downloads=1, gcs_download_bytes=len(image_bytes))
        return Response(
            content=image_bytes,
            media_type=content_type,
            headers={"Cache-Control": "private, max-age=60"},
        )
    except HTTPException:
        raise
    except ReceiptNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ImageStorageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SharedStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.patch("/items/master")
async def update_shared_item_master(payload: ItemMasterUpdate, user: AuthenticatedUser = Depends(require_authorized_user)):
    started_at = time.perf_counter()
    try:
        affected = await asyncio.to_thread(update_item_master, user.household_id, payload, user)
        await _record_activity_safely(user.household_id, duration_ms=_elapsed_ms(started_at), firestore_reads=max(1, affected), firestore_writes=affected)
        return {"success": True, "affected_receipts": affected}
    except SharedStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/auth/me")
async def auth_me(user: AuthenticatedUser = Depends(require_authorized_user)):
    return {
        "authenticated": True,
        "user": user.model_dump(exclude={"households"}),
        "household": {
            "id": user.household_id,
            "name": user.household_name,
            "role": user.household_role,
        },
        "households": user.households,
    }


@router.get("/household/members")
async def get_household_members(user: AuthenticatedUser = Depends(require_authorized_user)):
    try:
        result = await asyncio.to_thread(list_household_members, user)
        return {"success": True, "household": {"id": user.household_id, "name": user.household_name, "role": user.household_role}, **result}
    except TenantStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/household/invitations", status_code=201)
async def create_household_invitation(payload: HouseholdInviteCreate, user: AuthenticatedUser = Depends(require_authorized_user)):
    try:
        invitation = await asyncio.to_thread(invite_household_member, payload.email, user)
        return {"success": True, "invitation": invitation}
    except TenantStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete("/household/invitations/{invitation_id}")
async def delete_household_invitation(invitation_id: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    await asyncio.to_thread(cancel_invitation, invitation_id, user)
    return {"success": True}


@router.delete("/household/members/{subject}")
async def delete_household_member(subject: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    await asyncio.to_thread(remove_household_member, subject, user)
    return {"success": True}


@router.get("/admin/signup-requests")
async def get_signup_requests(user: AuthenticatedUser = Depends(require_authorized_user)):
    requests = await asyncio.to_thread(list_signup_requests, user)
    return {"success": True, "requests": requests, "count": len(requests)}


@router.post("/admin/signup-requests/{subject}/approve")
async def approve_signup_request(subject: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    approved = await asyncio.to_thread(approve_signup, subject, user)
    return {"success": True, "user": approved}


@router.get("/admin/users")
async def get_platform_users(user: AuthenticatedUser = Depends(require_authorized_user)):
    users = await asyncio.to_thread(list_platform_users, user)
    return {"success": True, "users": users, "count": len(users)}


@router.post("/admin/users/{subject}/ban")
async def ban_platform_user(subject: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    await asyncio.to_thread(ban_user, subject, user)
    return {"success": True}


@router.post("/admin/users/{subject}/unban")
async def unban_platform_user(subject: str, user: AuthenticatedUser = Depends(require_authorized_user)):
    await asyncio.to_thread(unban_user, subject, user)
    return {"success": True}


@router.get("/billing/summary")
async def get_billing_summary(
    user: AuthenticatedUser = Depends(require_authorized_user),
    period: str = "",
):
    require_household_owner(user)
    try:
        summary = await asyncio.to_thread(get_household_summary, user.household_id, period)
        return {"success": True, **summary}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BillingStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/billing/payment-qr")
async def get_billing_payment_qr(user: AuthenticatedUser = Depends(require_authorized_user)):
    require_household_owner(user)
    try:
        image_bytes, content_type = await asyncio.to_thread(download_payment_qr)
        return Response(
            content=image_bytes,
            media_type=content_type,
            headers={"Cache-Control": "private, max-age=300"},
        )
    except BillingStorageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/admin/billing/households")
async def get_admin_billing_households(
    user: AuthenticatedUser = Depends(require_authorized_user),
    period: str = "",
):
    require_platform_admin(user)
    try:
        payload = await asyncio.to_thread(list_household_summaries, period)
        return {"success": True, **payload}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BillingStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.patch("/admin/billing/households/{household_id}")
async def update_admin_household_limit(
    household_id: str,
    payload: HouseholdBillingLimitUpdate,
    user: AuthenticatedUser = Depends(require_authorized_user),
):
    require_platform_admin(user)
    try:
        summary = await asyncio.to_thread(set_household_limit, household_id, payload.monthly_limit_jpy)
        return {"success": True, **summary}
    except BillingStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/admin/billing/payment-qr")
async def update_admin_payment_qr(
    user: AuthenticatedUser = Depends(require_authorized_user),
    file: UploadFile = File(...),
):
    require_platform_admin(user)
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="PayPay加盟店QRの画像ファイルを指定してください。")
    try:
        image_bytes = await file.read()
        payment = await asyncio.to_thread(upload_payment_qr, image_bytes)
        return {"success": True, "payment": payment}
    except BillingStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "次世代家計簿 API",
        "shared_storage": bool(settings.FIRESTORE_DATABASE and settings.GCS_BUCKET_NAME),
        "multi_household": True,
    }
