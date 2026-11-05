from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator




class HouseholdInviteCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("有効なメールアドレスを指定してください。")
        return normalized


class HouseholdBillingAdminUpdate(BaseModel):
    usage_limit_jpy: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    outstanding_balance_jpy: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    monthly_limit_jpy: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    note: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def require_update(self) -> "HouseholdBillingAdminUpdate":
        if self.usage_limit_jpy is None and self.monthly_limit_jpy is not None:
            self.usage_limit_jpy = self.monthly_limit_jpy
        if self.usage_limit_jpy is None and self.outstanding_balance_jpy is None:
            raise ValueError("利用上限または未精算残高を指定してください。")
        self.note = self.note.strip()
        return self


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
    # receipt: AIで読み取ったレシート、manual: 手入力（家賃・サブスク・現金払いなど）
    entry_type: str = Field(default="receipt", pattern=r"^(receipt|manual)$")
    memo: str = Field(default="", max_length=500)
    # 固定費の今月分として記録した場合、その固定費のID。月の固定費の予定を置き換える。
    recurring_id: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")

    @field_validator("date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        normalized = value.strip()
        try:
            datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("dateはISO 8601形式で指定してください。") from exc
        return normalized

    @field_validator("store", "memo")
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


# ===== 家計簿ごとの設定（カテゴリ・予算・固定費） =====
# 色はテーマ（ライト/ダーク）ごとに検証済みの配色スロットを指す。生のHEXは保存しない。
CATEGORY_COLOR_PATTERN = r"^(c[1-8]|gray)$"
FALLBACK_CATEGORY = "その他"
MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


class CategorySetting(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    color: str = Field(default="gray", pattern=CATEGORY_COLOR_PATTERN)
    budget: int = Field(default=0, ge=0, le=100_000_000)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("カテゴリ名を入力してください。")
        return normalized


class RecurringExpense(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    # 0は「金額は毎月入力する」（電気代など）。
    amount: int = Field(default=0, ge=0, le=100_000_000)
    category: str = Field(default=FALLBACK_CATEGORY, min_length=1, max_length=40)
    day: int = Field(default=1, ge=1, le=31)
    start_month: str = Field(pattern=MONTH_PATTERN)
    end_month: str = Field(default="", pattern=r"^(\d{4}-(0[1-9]|1[0-2]))?$")
    memo: str = Field(default="", max_length=200)

    @field_validator("name", "category", "memo")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_period(self) -> "RecurringExpense":
        if not self.name:
            raise ValueError("固定費の名前を入力してください。")
        if self.end_month and self.end_month < self.start_month:
            raise ValueError("固定費の終了月は開始月以降にしてください。")
        return self


class HouseholdSettingsWrite(BaseModel):
    categories: List[CategorySetting] = Field(min_length=1, max_length=30)
    monthly_budget: int = Field(default=0, ge=0, le=1_000_000_000)
    recurring: List[RecurringExpense] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def normalize(self) -> "HouseholdSettingsWrite":
        seen: set[str] = set()
        unique: List[CategorySetting] = []
        for category in self.categories:
            if category.name in seen:
                raise ValueError(f"カテゴリ「{category.name}」が重複しています。")
            seen.add(category.name)
            unique.append(category)
        # 読み取り結果の受け皿として「その他」は常に残す。
        if FALLBACK_CATEGORY not in seen:
            unique.append(CategorySetting(name=FALLBACK_CATEGORY, color="gray"))
            seen.add(FALLBACK_CATEGORY)
        self.categories = unique

        recurring_ids: set[str] = set()
        for expense in self.recurring:
            if expense.id in recurring_ids:
                raise ValueError("固定費のIDが重複しています。")
            recurring_ids.add(expense.id)
            if expense.category not in seen:
                expense.category = FALLBACK_CATEGORY
        return self


class CategoryReassign(BaseModel):
    """カテゴリ名の変更、または別カテゴリへの統合（削除）。"""

    from_name: str = Field(min_length=1, max_length=40)
    to_name: str = Field(min_length=1, max_length=40)

    @field_validator("from_name", "to_name")
    @classmethod
    def strip_names(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def require_change(self) -> "CategoryReassign":
        if not self.from_name or not self.to_name:
            raise ValueError("カテゴリ名を入力してください。")
        if self.from_name == self.to_name:
            raise ValueError("変更前と変更後のカテゴリ名が同じです。")
        return self
