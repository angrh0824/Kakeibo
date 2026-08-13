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
    PLATFORM_ADMIN_EMAILS: str = ""
    LEGACY_HOUSEHOLD_ID: str = "family-main"
    LEGACY_HOUSEHOLD_NAME: str = "わが家の家計簿"
    ALLOW_SIGNUP_REQUESTS: bool = True
    
    OPENROUTER_API_KEY: str = ""
    DEFAULT_AI_MODEL: str = "google/gemini-2.5-flash-lite"
    FIRESTORE_DATABASE: str = "(default)"
    GCS_BUCKET_NAME: str = ""
    GCS_RECEIPT_PREFIX: str = "receipts"
    GCS_SIGNED_URL_TTL_SECONDS: int = 900
    RECEIPT_IMAGE_MAX_UPLOAD_BYTES: int = 15000000
    RECEIPT_IMAGE_MAX_BYTES: int = 1500000
    RECEIPT_IMAGE_MAX_DIMENSION: int = 1800
    RECEIPT_IMAGE_JPEG_QUALITY: int = 82
    BILLING_ENABLED: bool = False
    BILLING_MARKUP_PERCENT: int = 100
    BILLING_USD_JPY_RATE: float = 150.0
    BILLING_DEFAULT_MONTHLY_LIMIT_JPY: int = 1000
    BILLING_ANALYSIS_RESERVE_JPY: int = 10
    BILLING_CLOUD_RUN_VCPU: float = 1.0
    BILLING_CLOUD_RUN_MEMORY_GIB: float = 0.5
    BILLING_CLOUD_RUN_CPU_USD_PER_SECOND: float = 0.000024
    BILLING_CLOUD_RUN_MEMORY_USD_PER_GIB_SECOND: float = 0.0000025
    BILLING_CLOUD_RUN_REQUEST_USD_PER_MILLION: float = 0.40
    BILLING_FIRESTORE_READ_USD_PER_100K: float = 0.03
    BILLING_FIRESTORE_WRITE_USD_PER_100K: float = 0.09
    BILLING_FIRESTORE_DELETE_USD_PER_100K: float = 0.01
    BILLING_GCS_STORAGE_USD_PER_GIB_MONTH: float = 0.023
    BILLING_GCS_CLASS_A_USD_PER_1000: float = 0.005
    BILLING_GCS_CLASS_B_USD_PER_1000: float = 0.0004
    BILLING_GCS_EGRESS_USD_PER_GIB: float = 0.12
    BILLING_PAYPAY_RECIPIENT: str = "家計簿管理者"
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./kakeibo.db")
    
    class Config:
        env_file = str(Path(__file__).resolve().parents[1] / ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"

settings = Settings()
