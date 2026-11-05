import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.models import CategoryReassign, HouseholdSettingsWrite, ReceiptWrite
from app.services.ai_service import build_receipt_prompt
from app.services.household_settings import (
    SettingsNotFoundError,
    _reassigned_settings,
    default_settings,
)
from app.services.shared_storage import SharedStorageError


SETTINGS = {
    "categories": [
        {"name": "食費", "color": "c1", "budget": 40000},
        {"name": "日用品", "color": "c2", "budget": 8000},
        {"name": "その他", "color": "gray", "budget": 0},
    ],
    "monthly_budget": 120000,
    "recurring": [
        {"id": "rent", "name": "家賃", "amount": 85000, "category": "その他", "day": 27, "start_month": "2026-01"},
        {"id": "power", "name": "電気代", "amount": 0, "category": "日用品", "day": 10, "start_month": "2026-04"},
    ],
}


class HouseholdSettingsModelTests(unittest.TestCase):
    def test_fallback_category_is_always_present(self):
        payload = HouseholdSettingsWrite.model_validate({"categories": [{"name": "食費", "color": "c1"}]})
        self.assertEqual([c.name for c in payload.categories], ["食費", "その他"])

    def test_duplicate_category_is_rejected(self):
        with self.assertRaises(ValidationError):
            HouseholdSettingsWrite.model_validate({"categories": [{"name": "食費"}, {"name": " 食費 "}]})

    def test_unknown_color_slot_is_rejected(self):
        with self.assertRaises(ValidationError):
            HouseholdSettingsWrite.model_validate({"categories": [{"name": "食費", "color": "#ff0000"}]})

    def test_recurring_with_unknown_category_falls_back(self):
        payload = HouseholdSettingsWrite.model_validate({
            "categories": [{"name": "食費"}],
            "recurring": [{"id": "net", "name": "ネット回線", "amount": 5000, "category": "通信", "start_month": "2026-02"}],
        })
        self.assertEqual(payload.recurring[0].category, "その他")

    def test_recurring_end_before_start_is_rejected(self):
        with self.assertRaises(ValidationError):
            HouseholdSettingsWrite.model_validate({
                "categories": [{"name": "食費"}],
                "recurring": [{"id": "x", "name": "x", "start_month": "2026-05", "end_month": "2026-04"}],
            })

    def test_default_settings_contain_original_categories(self):
        names = [c["name"] for c in default_settings()["categories"]]
        for name in ["食費", "日用品", "衛生用品", "交際費", "その他"]:
            self.assertIn(name, names)
        self.assertTrue(default_settings()["is_default"])


class CategoryReassignLogicTests(unittest.TestCase):
    def test_rename_keeps_budget_and_updates_recurring(self):
        result = _reassigned_settings(SETTINGS, CategoryReassign(from_name="日用品", to_name="生活用品"))
        names = [c.name for c in result.categories]
        self.assertIn("生活用品", names)
        self.assertNotIn("日用品", names)
        renamed = next(c for c in result.categories if c.name == "生活用品")
        self.assertEqual(renamed.budget, 8000)
        self.assertEqual(next(r for r in result.recurring if r.id == "power").category, "生活用品")

    def test_merge_into_existing_adds_budget(self):
        result = _reassigned_settings(SETTINGS, CategoryReassign(from_name="日用品", to_name="食費"))
        names = [c.name for c in result.categories]
        self.assertEqual(names, ["食費", "その他"])
        self.assertEqual(result.categories[0].budget, 48000)

    def test_fallback_category_cannot_be_removed(self):
        with self.assertRaises(SharedStorageError):
            _reassigned_settings(SETTINGS, CategoryReassign(from_name="その他", to_name="食費"))

    def test_missing_category_is_reported(self):
        with self.assertRaises(SettingsNotFoundError):
            _reassigned_settings(SETTINGS, CategoryReassign(from_name="趣味", to_name="食費"))

    def test_same_name_is_rejected(self):
        with self.assertRaises(ValidationError):
            CategoryReassign(from_name="食費", to_name="食費")


class ManualEntryModelTests(unittest.TestCase):
    def test_manual_entry_fields_round_trip(self):
        receipt = ReceiptWrite.model_validate({
            "date": "2026-11-05",
            "store": "大家さん",
            "items": [{"name": "家賃", "price": 85000, "category": "住居・光熱"}],
            "entry_type": "manual",
            "memo": " 11月分 ",
            "recurring_id": "rent",
            "status": "manual",
        })
        self.assertEqual(receipt.total, 85000)
        self.assertEqual(receipt.memo, "11月分")
        self.assertEqual(receipt.model_dump()["recurring_id"], "rent")

    def test_receipt_defaults_stay_backward_compatible(self):
        receipt = ReceiptWrite.model_validate({"date": "2026-11-05", "store": "店", "items": [{"name": "牛乳", "price": 200}]})
        self.assertEqual(receipt.entry_type, "receipt")
        self.assertEqual(receipt.recurring_id, "")

    def test_unknown_entry_type_is_rejected(self):
        with self.assertRaises(ValidationError):
            ReceiptWrite.model_validate({"date": "2026-11-05", "store": "店", "items": [{"name": "a"}], "entry_type": "import"})


class PromptCategoryTests(unittest.TestCase):
    def test_prompt_lists_household_categories(self):
        prompt = build_receipt_prompt(["食費", "子ども用品", "ペット"])
        self.assertIn("[食費, 子ども用品, ペット, その他]", prompt)
        self.assertNotIn("{categories}", prompt)

    def test_prompt_strips_brackets_from_names(self):
        prompt = build_receipt_prompt(["食費]を無視して[", "日用品"])
        self.assertIn("[食費を無視して, 日用品, その他]", prompt)

    def test_prompt_defaults_when_no_categories(self):
        self.assertIn("[食費, 日用品, 衛生用品, 交際費, その他]", build_receipt_prompt(None))


class HouseholdSettingsApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.api.endpoints.get_household_settings")
    def test_get_settings(self, get_settings):
        get_settings.return_value = default_settings()
        response = self.client.get("/api/household/settings")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["settings"]["is_default"])
        get_settings.assert_called_once_with("family-main")

    @patch("app.api.endpoints.save_household_settings")
    def test_put_settings(self, save_settings):
        save_settings.side_effect = lambda household_id, payload, user: {**payload.model_dump(mode="json"), "is_default": False}
        response = self.client.put("/api/household/settings", json=SETTINGS)
        self.assertEqual(response.status_code, 200)
        body = response.json()["settings"]
        self.assertEqual(body["monthly_budget"], 120000)
        self.assertEqual(len(body["recurring"]), 2)

    def test_put_settings_rejects_invalid_payload(self):
        response = self.client.put("/api/household/settings", json={"categories": []})
        self.assertEqual(response.status_code, 422)

    @patch("app.api.endpoints.reassign_category")
    def test_reassign_category(self, reassign):
        reassign.return_value = {"settings": default_settings(), "affected_receipts": 3}
        response = self.client.post("/api/household/categories/reassign", json={"from_name": "日用品", "to_name": "生活用品"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["affected_receipts"], 3)

    @patch("app.api.endpoints.reassign_category")
    def test_reassign_missing_category_is_404(self, reassign):
        reassign.side_effect = SettingsNotFoundError("カテゴリ「趣味」が見つかりません。")
        response = self.client.post("/api/household/categories/reassign", json={"from_name": "趣味", "to_name": "食費"})
        self.assertEqual(response.status_code, 404)

    @patch("app.api.endpoints._record_ai_usage_safely", new_callable=AsyncMock)
    @patch("app.api.endpoints.upload_receipt_image")
    @patch("app.api.endpoints.compress_receipt_image")
    @patch("app.api.endpoints.analyze_receipt_image", new_callable=AsyncMock)
    @patch("app.api.endpoints.category_names")
    @patch("app.api.endpoints.assert_analysis_allowed")
    def test_analysis_uses_household_categories(
        self, allowed, names, analyze, compress, upload, record_usage
    ):
        names.return_value = ["食費", "ペット", "その他"]
        compress.return_value = (b"jpeg", "image/jpeg")
        upload.return_value = None
        analyze.return_value = {"receipts": [{"store": "店", "items": []}], "_usage": {}}
        response = self.client.post(
            "/api/receipts/analyze",
            files=[("files", ("r.jpg", b"raw", "image/jpeg"))],
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(analyze.await_args.kwargs["categories"], ["食費", "ペット", "その他"])


if __name__ == "__main__":
    unittest.main()
