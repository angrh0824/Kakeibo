import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.api.endpoints import router as api_router

logging.basicConfig(level=logging.INFO if settings.DEBUG else logging.WARNING)
logger = logging.getLogger(__name__)

app = FastAPI(
    title=settings.APP_NAME,
    description="OpenRouterマルチモーダルAIを用いた次世代家計簿 API",
    version="2.0.0"
)
frontend_origins = [origin.strip() for origin in settings.FRONTEND_ORIGINS.split(",") if origin.strip()]
if not frontend_origins:
    frontend_origins = ["*"]


# CORS の許可設定 (フロントエンドからのリクエストを許可)
app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origins,
    allow_credentials=frontend_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# API ルーターの登録
app.include_router(api_router, prefix="/api")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
