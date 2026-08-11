from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class ReceiptItemWrite(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    price: int = Field(default=0, ge=0, le=100_000_000)
    quantity: int = Field(default=1, ge=1, le=10_000)
    category: str = Field(default="その他", min_length=1, max_length=100)
    line_total: Optional[int] = Field(default=None, ge=0, le=100_000_000)

    @field_validator("name", "category")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def fill_line_total(self) -> "ReceiptItemWrite":
        if self.line_total is None:
            self.line_total = self.price * self.quantity
        return self


class ImageStorageReference(BaseModel):
    provider: str = Field(default="gcs", max_length=20)
    bucket: str = Field(max_length=255)
    object_name: str = Field(max_length=1024)
    content_type: str = Field(default="image/jpeg", max_length=100)
    size_bytes: int = Field(default=0, ge=0, le=20_000_000)
    sha256: str = Field(default="", max_length=128)


class ReceiptWrite(BaseModel):
    date: str = Field(min_length=1, max_length=64)
    store: str = Field(min_length=1, max_length=300)
    source_filename: str = Field(default="", max_length=500)
    image_storage: Optional[ImageStorageReference] = None
    items: List[ReceiptItemWrite] = Field(min_length=1, max_length=250)
    total: int = Field(default=0, ge=0, le=1_000_000_000)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    status: str = Field(default="validated", pattern=r"^[a-zA-Z0-9_-]{1,40}$")

    @field_validator("date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        normalized = value.strip()
        try:
            datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("dateはISO 8601形式で指定してください。") from exc
        return normalized

    @field_validator("store")
    @classmethod
    def strip_store(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def calculate_total(self) -> "ReceiptWrite":
        self.total = sum(int(item.line_total or 0) for item in self.items)
        return self


class ItemMasterUpdate(BaseModel):
    old_name: str = Field(min_length=1, max_length=300)
    new_name: str = Field(min_length=1, max_length=300)
    category: str = Field(min_length=1, max_length=100)

    @field_validator("old_name", "new_name", "category")
    @classmethod
    def strip_values(cls, value: str) -> str:
        return value.strip()