import os
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "次世代家計簿 API"
    DEBUG: bool = True
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    FRONTEND_ORIGINS: str = "*"
    AUTH_REQUIRED: bool = False
    GOOGLE_OAUTH_CLIENT_ID: str = ""
    ALLOWED_USER_EMAILS: str = ""
    
    OPENROUTER_API_KEY: str = ""
    DEFAULT_AI_MODEL: str = "google/gemma-4-31b-it"
    GCS_BUCKET_NAME: str = ""
    GCS_RECEIPT_PREFIX: str = "receipts"
    GCS_SIGNED_URL_TTL_SECONDS: int = 900
    RECEIPT_IMAGE_MAX_UPLOAD_BYTES: int = 15000000
    RECEIPT_IMAGE_MAX_BYTES: int = 1500000
    RECEIPT_IMAGE_MAX_DIMENSION: int = 1800
    RECEIPT_IMAGE_JPEG_QUALITY: int = 82
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./kakeibo.db")
    
    class Config:
        env_file = str(Path(__file__).resolve().parents[1] / ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"

settings = Settings()
