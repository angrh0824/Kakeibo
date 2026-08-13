"""Firestore-backed account approval, household membership and platform administration."""

from __future__ import annotations

from datetime import datetime
import hashlib
import logging
import re
import threading
import uuid
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from fastapi import HTTPException
from google.cloud import firestore

from app.config import settings

if TYPE_CHECKING:
    from app.auth import AuthenticatedUser

logger = logging.getLogger(__name__)
USERS = "platform_users"
SIGNUP_REQUESTS = "signup_requests"
HOUSEHOLDS = "households"
INVITATIONS = "household_invitations"
_client: Optional[firestore.Client] = None
_client_lock = threading.Lock()


class TenantStorageError(RuntimeError):
    """Raised when account or household metadata cannot be accessed."""


def _firestore_client() -> firestore.Client:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                try:
                    _client = firestore.Client(database=settings.FIRESTORE_DATABASE)
                except Exception as exc:
                    raise TenantStorageError("利用者データベースへ接続できませんでした。") from exc
    return _client


def _email_set(raw: str) -> set[str]:
    return {value.strip().lower() for value in raw.split(",") if value.strip()}


def platform_admin_emails() -> set[str]:
    configured = _email_set(settings.PLATFORM_ADMIN_EMAILS)
    if configured:
        return configured
    for value in settings.ALLOWED_USER_EMAILS.split(","):
        normalized = value.strip().lower()
        if normalized:
            return {normalized}
    return set()


def legacy_family_emails() -> set[str]:
    return _email_set(settings.ALLOWED_USER_EMAILS)


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _new_household_id(prefix: str = "home") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:20]}"


def legacy_household_id() -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]", "-", settings.LEGACY_HOUSEHOLD_ID.strip())
    return value.strip("-") or "family-main"


def _audit_identity(identity: "AuthenticatedUser") -> Dict[str, str]:
    return {
        "subject": identity.subject,
        "email": identity.email,
        "name": identity.name or identity.email,
    }


def _create_household(client: firestore.Client, household_id: str, name: str, owner: "AuthenticatedUser") -> None:
    client.collection(HOUSEHOLDS).document(household_id).set({
        "name": name,
        "owner_subject": owner.subject,
        "owner_email": owner.email,
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    })


def _ensure_legacy_user(identity: "AuthenticatedUser", is_admin: bool) -> None:
    client = _firestore_client()
    household_id = legacy_household_id()
    household_ref = client.collection(HOUSEHOLDS).document(household_id)
    household = household_ref.get()
    if not household.exists:
        _create_household(client, household_id, settings.LEGACY_HOUSEHOLD_NAME, identity)
    elif is_admin:
        household_ref.set({
            "owner_subject": identity.subject,
            "owner_email": identity.email,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
    client.collection(USERS).document(identity.subject).set({
        **_audit_identity(identity),
        "picture": identity.picture,
        "status": "active",
        "is_admin": is_admin,
        "default_household_id": household_id,
        "memberships": {household_id: "owner" if is_admin else "member"},
        "approved_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)


def _create_signup_request(identity: "AuthenticatedUser") -> None:
    client = _firestore_client()
    client.collection(USERS).document(identity.subject).set({
        **_audit_identity(identity),
        "picture": identity.picture,
        "status": "pending",
        "is_admin": False,
        "memberships": {},
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    client.collection(SIGNUP_REQUESTS).document(identity.subject).set({
        **_audit_identity(identity),
        "picture": identity.picture,
        "status": "pending",
        "requested_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    logger.warning("KAKEIBO_SIGNUP_REQUEST email=%s name=%s", identity.email, identity.name or identity.email)


def _load_households(memberships: Dict[str, str]) -> List[Dict[str, Any]]:
    client = _firestore_client()
    households: List[Dict[str, Any]] = []
    for household_id, role in memberships.items():
        snapshot = client.collection(HOUSEHOLDS).document(household_id).get()
        if not snapshot.exists:
            continue
        data = snapshot.to_dict() or {}
        households.append({
            "id": household_id,
            "name": str(data.get("name") or "家計簿"),
            "role": role,
            "owner_subject": str(data.get("owner_subject") or ""),
        })
    return sorted(households, key=lambda item: (item["role"] != "owner", item["name"]))


def authorize_identity(identity: "AuthenticatedUser", requested_household_id: str = "") -> "AuthenticatedUser":
    """Resolve a verified Google identity into an active household context."""
    from app.auth import AuthenticatedUser

    if not settings.AUTH_REQUIRED:
        household_id = legacy_household_id()
        return identity.model_copy(update={
            "status": "active",
            "is_admin": True,
            "household_id": household_id,
            "household_name": settings.LEGACY_HOUSEHOLD_NAME,
            "household_role": "owner",
            "households": [{"id": household_id, "name": settings.LEGACY_HOUSEHOLD_NAME, "role": "owner"}],
        })

    try:
        client = _firestore_client()
        user_ref = client.collection(USERS).document(identity.subject)
        snapshot = user_ref.get()
        is_admin_email = identity.email in platform_admin_emails()
        if not snapshot.exists and (identity.email in legacy_family_emails() or is_admin_email):
            _ensure_legacy_user(identity, is_admin_email)
            snapshot = user_ref.get()
        if not snapshot.exists:
            if not settings.ALLOW_SIGNUP_REQUESTS:
                raise HTTPException(status_code=403, detail="新規利用申請は現在受け付けていません。")
            _create_signup_request(identity)
            raise HTTPException(status_code=403, detail={
                "code": "approval_pending",
                "message": "利用申請を受け付けました。管理者の承認後にログインできます。",
            })

        data = snapshot.to_dict() or {}
        account_status = str(data.get("status") or "pending")
        if account_status == "banned":
            raise HTTPException(status_code=403, detail={
                "code": "account_banned",
                "message": "このアカウントは管理者により利用停止されています。",
            })
        if account_status != "active":
            client.collection(SIGNUP_REQUESTS).document(identity.subject).set({
                **_audit_identity(identity),
                "picture": identity.picture,
                "status": "pending",
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            raise HTTPException(status_code=403, detail={
                "code": "approval_pending",
                "message": "利用申請は承認待ちです。管理者の承認後にもう一度ログインしてください。",
            })

        memberships = dict(data.get("memberships") or {})
        if not memberships:
            raise HTTPException(status_code=403, detail="利用できる家計簿がありません。")
        selected_id = requested_household_id.strip()
        if selected_id not in memberships:
            selected_id = str(data.get("default_household_id") or "")
        if selected_id not in memberships:
            selected_id = next(iter(memberships))
        households = _load_households(memberships)
        selected = next((item for item in households if item["id"] == selected_id), None)
        if selected is None:
            raise HTTPException(status_code=403, detail="選択した家計簿を利用できません。")

        user_ref.set({
            "email": identity.email,
            "name": identity.name or identity.email,
            "picture": identity.picture,
            "is_admin": bool(data.get("is_admin")) or is_admin_email,
            "last_login_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        return AuthenticatedUser(
            subject=identity.subject,
            email=identity.email,
            name=identity.name,
            picture=identity.picture,
            status="active",
            is_admin=bool(data.get("is_admin")) or is_admin_email,
            household_id=selected_id,
            household_name=selected["name"],
            household_role=str(memberships[selected_id]),
            households=households,
        )
    except HTTPException:
        raise
    except TenantStorageError:
        raise
    except Exception as exc:
        logger.error("Account authorization failed", exc_info=True)
        raise TenantStorageError("利用者権限を確認できませんでした。") from exc


def require_household_owner(user: "AuthenticatedUser") -> None:
    if user.household_role != "owner":
        raise HTTPException(status_code=403, detail="家計簿オーナーだけが操作できます。")


def require_platform_admin(user: "AuthenticatedUser") -> None:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="管理者だけが操作できます。")


def list_household_members(user: "AuthenticatedUser") -> Dict[str, Any]:
    client = _firestore_client()
    members: List[Dict[str, Any]] = []
    for snapshot in client.collection(USERS).stream():
        data = snapshot.to_dict() or {}
        memberships = dict(data.get("memberships") or {})
        if user.household_id not in memberships:
            continue
        members.append({
            "subject": snapshot.id,
            "email": str(data.get("email") or ""),
            "name": str(data.get("name") or data.get("email") or ""),
            "picture": str(data.get("picture") or ""),
            "role": str(memberships[user.household_id]),
            "status": str(data.get("status") or "pending"),
        })
    invitations = []
    query = client.collection(INVITATIONS).where("household_id", "==", user.household_id)
    for snapshot in query.stream():
        data = snapshot.to_dict() or {}
        if data.get("status") == "pending":
            invitations.append({"id": snapshot.id, **_json_value(data)})
    return {"members": members, "invitations": invitations}


def invite_household_member(email: str, user: "AuthenticatedUser") -> Dict[str, Any]:
    require_household_owner(user)
    normalized = email.strip().lower()
    if normalized == user.email:
        raise HTTPException(status_code=400, detail="自分自身はすでにこの家計簿のメンバーです。")
    client = _firestore_client()
    invitation_id = hashlib.sha256(f"{user.household_id}:{normalized}".encode("utf-8")).hexdigest()[:32]
    invitation: Dict[str, Any] = {
        "household_id": user.household_id,
        "household_name": user.household_name,
        "email": normalized,
        "role": "member",
        "status": "pending",
        "invited_by": _audit_identity(user),
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }

    matching_users = list(client.collection(USERS).where("email", "==", normalized).limit(1).stream())
    if matching_users:
        target = matching_users[0]
        target_data = target.to_dict() or {}
        if target_data.get("status") == "banned":
            raise HTTPException(status_code=400, detail="利用停止中のアカウントは招待できません。")
        if target_data.get("status") == "active":
            memberships = dict(target_data.get("memberships") or {})
            memberships[user.household_id] = "member"
            target.reference.set({"memberships": memberships, "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)
            invitation["status"] = "accepted"
            invitation["accepted_at"] = firestore.SERVER_TIMESTAMP

    client.collection(INVITATIONS).document(invitation_id).set(invitation, merge=True)
    return {"id": invitation_id, **_json_value(invitation)}


def remove_household_member(subject: str, user: "AuthenticatedUser") -> None:
    require_household_owner(user)
    client = _firestore_client()
    ref = client.collection(USERS).document(subject)
    snapshot = ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="メンバーが見つかりません。")
    data = snapshot.to_dict() or {}
    memberships = dict(data.get("memberships") or {})
    if memberships.get(user.household_id) == "owner":
        raise HTTPException(status_code=400, detail="家計簿オーナーは削除できません。")
    if user.household_id not in memberships:
        raise HTTPException(status_code=404, detail="メンバーが見つかりません。")
    memberships.pop(user.household_id, None)
    update: Dict[str, Any] = {"memberships": memberships, "updated_at": firestore.SERVER_TIMESTAMP}
    if data.get("default_household_id") == user.household_id:
        update["default_household_id"] = next(iter(memberships), "")
    ref.set(update, merge=True)


def cancel_invitation(invitation_id: str, user: "AuthenticatedUser") -> None:
    require_household_owner(user)
    ref = _firestore_client().collection(INVITATIONS).document(invitation_id)
    snapshot = ref.get()
    if not snapshot.exists or (snapshot.to_dict() or {}).get("household_id") != user.household_id:
        raise HTTPException(status_code=404, detail="招待が見つかりません。")
    ref.set({"status": "cancelled", "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)


def list_signup_requests(user: "AuthenticatedUser") -> List[Dict[str, Any]]:
    require_platform_admin(user)
    requests = []
    query = _firestore_client().collection(SIGNUP_REQUESTS).where("status", "==", "pending")
    for snapshot in query.stream():
        requests.append({"subject": snapshot.id, **_json_value(snapshot.to_dict() or {})})
    return requests


def list_platform_users(user: "AuthenticatedUser") -> List[Dict[str, Any]]:
    require_platform_admin(user)
    users = []
    for snapshot in _firestore_client().collection(USERS).stream():
        data = snapshot.to_dict() or {}
        users.append({
            "subject": snapshot.id,
            "email": str(data.get("email") or ""),
            "name": str(data.get("name") or data.get("email") or ""),
            "status": str(data.get("status") or "pending"),
            "is_admin": bool(data.get("is_admin")),
            "household_count": len(dict(data.get("memberships") or {})),
        })
    return sorted(users, key=lambda item: item["email"])


def approve_signup(subject: str, admin: "AuthenticatedUser") -> Dict[str, Any]:
    require_platform_admin(admin)
    client = _firestore_client()
    user_ref = client.collection(USERS).document(subject)
    snapshot = user_ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="利用申請が見つかりません。")
    data = snapshot.to_dict() or {}
    if data.get("status") == "active":
        return {"subject": subject, "email": str(data.get("email") or ""), "status": "active"}
    if data.get("status") == "banned":
        raise HTTPException(status_code=400, detail="BAN中の利用者は先にBAN解除してください。")
    identity_email = str(data.get("email") or "")
    from app.auth import AuthenticatedUser
    identity = AuthenticatedUser(
        subject=subject,
        email=identity_email,
        name=str(data.get("name") or identity_email),
        picture=str(data.get("picture") or ""),
    )
    memberships = dict(data.get("memberships") or {})
    household_id = _new_household_id("personal")
    _create_household(client, household_id, f"{identity.name}の家計簿", identity)
    memberships[household_id] = "owner"

    invitation_query = client.collection(INVITATIONS).where("email", "==", identity_email)
    for invitation_snapshot in invitation_query.stream():
        invitation = invitation_snapshot.to_dict() or {}
        if invitation.get("status") != "pending":
            continue
        invited_household = str(invitation.get("household_id") or "")
        if invited_household:
            memberships[invited_household] = str(invitation.get("role") or "member")
            invitation_snapshot.reference.set({
                "status": "accepted",
                "accepted_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)

    user_ref.set({
        "status": "active",
        "memberships": memberships,
        "default_household_id": household_id,
        "approved_at": firestore.SERVER_TIMESTAMP,
        "approved_by": _audit_identity(admin),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    client.collection(SIGNUP_REQUESTS).document(subject).set({
        "status": "approved",
        "approved_at": firestore.SERVER_TIMESTAMP,
        "approved_by": _audit_identity(admin),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return {"subject": subject, "email": identity_email, "status": "active"}


def ban_user(subject: str, admin: "AuthenticatedUser") -> None:
    require_platform_admin(admin)
    if subject == admin.subject:
        raise HTTPException(status_code=400, detail="自分自身を利用停止にはできません。")
    ref = _firestore_client().collection(USERS).document(subject)
    if not ref.get().exists:
        raise HTTPException(status_code=404, detail="利用者が見つかりません。")
    ref.set({
        "status": "banned",
        "banned_at": firestore.SERVER_TIMESTAMP,
        "banned_by": _audit_identity(admin),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)


def unban_user(subject: str, admin: "AuthenticatedUser") -> None:
    require_platform_admin(admin)
    ref = _firestore_client().collection(USERS).document(subject)
    snapshot = ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="利用者が見つかりません。")
    data = snapshot.to_dict() or {}
    next_status = "active" if data.get("memberships") else "pending"
    ref.set({
        "status": next_status,
        "unbanned_at": firestore.SERVER_TIMESTAMP,
        "unbanned_by": _audit_identity(admin),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
