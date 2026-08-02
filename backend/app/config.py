import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "次世代家計簿 API"
    DEBUG: bool = True
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
    DEFAULT_AI_MODEL: str = os.getenv("DEFAULT_AI_MODEL", "google/gemma-4-31b-it")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./kakeibo.db")
    
    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
