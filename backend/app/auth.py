from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)
bearer_scheme = HTTPBearer(auto_error=False)


class AuthenticatedUser(BaseModel):
    subject: str
    email: str
    name: str = ""
    picture: str = ""
    status: str = ""
    is_admin: bool = False
    household_id: str = ""
    household_name: str = ""
    household_role: str = ""
    households: List[Dict[str, Any]] = Field(default_factory=list)


def _verify_google_id_token(token: str) -> dict:
    return google_id_token.verify_oauth2_token(
        token,
        google_requests.Request(),
        settings.GOOGLE_OAUTH_CLIENT_ID,
    )


async def require_authorized_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    x_household_id: str = Header(default="", alias="X-Household-ID"),
) -> AuthenticatedUser:
    """Google IDトークン、利用状態、選択中の家計簿メンバー権限を検証します。"""
    from app.services.tenant_service import TenantStorageError, authorize_identity

    if not settings.AUTH_REQUIRED:
        identity = AuthenticatedUser(subject="local-dev", email="local-dev@localhost", name="Local user")
        return authorize_identity(identity, x_household_id)

    if not settings.GOOGLE_OAUTH_CLIENT_ID:
        logger.error("AUTH_REQUIRED is enabled but GOOGLE_OAUTH_CLIENT_ID is empty")
        raise HTTPException(status_code=503, detail="認証設定が完了していません。")

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Googleログインが必要です。",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        token_info = await asyncio.to_thread(_verify_google_id_token, credentials.credentials)
    except ValueError as exc:
        logger.info("Rejected an invalid Google ID token: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="ログインの有効期限が切れたか、認証情報が正しくありません。",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except Exception as exc:
        logger.warning("Google ID token verification failed: %s", exc)
        raise HTTPException(status_code=503, detail="Google認証を確認できませんでした。") from exc

    email = str(token_info.get("email") or "").strip().lower()
    email_verified = token_info.get("email_verified") is True or str(token_info.get("email_verified")).lower() == "true"
    subject = str(token_info.get("sub") or "").strip()
    if not subject or not email or not email_verified:
        raise HTTPException(status_code=403, detail="確認済みのGoogleアカウントが必要です。")

    identity = AuthenticatedUser(
        subject=subject,
        email=email,
        name=str(token_info.get("name") or email),
        picture=str(token_info.get("picture") or ""),
    )
    try:
        return await asyncio.to_thread(authorize_identity, identity, x_household_id)
    except HTTPException:
        raise
    except TenantStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
