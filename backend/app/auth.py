from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
bearer_scheme = HTTPBearer(auto_error=False)


class AuthenticatedUser(BaseModel):
    subject: str
    email: str
    name: str = ""
    picture: str = ""


def _allowed_emails() -> set[str]:
    return {
        email.strip().lower()
        for email in settings.ALLOWED_USER_EMAILS.split(",")
        if email.strip()
    }


def _verify_google_id_token(token: str) -> dict:
    return google_id_token.verify_oauth2_token(
        token,
        google_requests.Request(),
        settings.GOOGLE_OAUTH_CLIENT_ID,
    )


async def require_authorized_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> AuthenticatedUser:
    """Google IDトークンを検証し、家族の許可メールだけを通します。"""
    if not settings.AUTH_REQUIRED:
        return AuthenticatedUser(subject="local-dev", email="local-dev@localhost", name="Local user")

    if not settings.GOOGLE_OAUTH_CLIENT_ID:
        logger.error("AUTH_REQUIRED is enabled but GOOGLE_OAUTH_CLIENT_ID is empty")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="認証設定が完了していません。")

    allowed_emails = _allowed_emails()
    if not allowed_emails:
        logger.error("AUTH_REQUIRED is enabled but ALLOWED_USER_EMAILS is empty")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="利用者設定が完了していません。")

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
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Google認証を確認できませんでした。") from exc

    email = str(token_info.get("email") or "").strip().lower()
    email_verified = token_info.get("email_verified") is True or str(token_info.get("email_verified")).lower() == "true"
    if not email or not email_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="確認済みのGoogleメールアドレスが必要です。")
    if email not in allowed_emails:
        logger.warning("Rejected a Google account outside the allowlist")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="このGoogleアカウントには利用権限がありません。")

    return AuthenticatedUser(
        subject=str(token_info.get("sub") or ""),
        email=email,
        name=str(token_info.get("name") or email),
        picture=str(token_info.get("picture") or ""),
    )