import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_authorized_user
from app.config import settings
from app.main import app
from app.services.billing_service import (
    MonthlyLimitExceeded,
    assert_analysis_allowed,
    calculate_balance,
    calculate_costs,
    normalize_period,
)


class BillingCalculationTests(unittest.TestCase):
    def test_actual_cost_is_doubled_for_paypay_amount(self):
        with (
            patch.object(settings, "BILLING_MARKUP_PERCENT", 100),
            patch.object(settings, "BILLING_USD_JPY_RATE", 150.0),
        ):
            costs = calculate_costs({"ai_cost_usd": 0.01}, {})
        self.assertEqual(costs["estimated_cost_jpy"], 1.5)
        self.assertEqual(costs["payment_amount_jpy"], 3)
        self.assertEqual(costs["service_fee_jpy"], 1.5)

    def test_fee_stays_exact_when_final_total_is_rounded_up(self):
        with (
            patch.object(settings, "BILLING_MARKUP_PERCENT", 100),
            patch.object(settings, "BILLING_USD_JPY_RATE", 150.0),
        ):
            costs = calculate_costs({"ai_cost_usd": 0.007333}, {})
        self.assertEqual(costs["estimated_cost_jpy"], 1.1)
        self.assertEqual(costs["service_fee_jpy"], 1.1)
        self.assertEqual(costs["payment_amount_jpy"], 3)

    def test_cumulative_balance_reaches_usage_limit(self):
        balance = calculate_balance(1200, -200, 1000)
        self.assertEqual(balance["outstanding_balance_jpy"], 1000)
        self.assertEqual(balance["status"], "blocked")
        self.assertFalse(balance["can_analyze"])

    def test_zeroing_balance_keeps_history_and_future_cost_accumulates(self):
        settled = calculate_balance(500, -500, 1000)
        later = calculate_balance(530, -500, 1000)
        self.assertEqual(settled["total_charges_jpy"], 500)
        self.assertEqual(settled["outstanding_balance_jpy"], 0)
        self.assertEqual(later["outstanding_balance_jpy"], 30)

    @patch("app.services.billing_service.get_household_summary")
    def test_batch_preflight_reserves_each_image(self, get_summary):
        get_summary.return_value = {"balance": {"usage_limit_jpy": 100, "outstanding_balance_jpy": 85}}
        with (
            patch.object(settings, "BILLING_ENABLED", True),
            patch.object(settings, "BILLING_ANALYSIS_RESERVE_JPY", 10),
        ):
            with self.assertRaises(MonthlyLimitExceeded):
                assert_analysis_allowed("family-main", requested_images=2)

    def test_period_must_be_year_month(self):
        self.assertEqual(normalize_period("2026-08"), "2026-08")
        with self.assertRaises(ValueError):
            normalize_period("2026-13")


class BillingApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.api.endpoints.get_household_summary")
    def test_owner_can_view_household_billing(self, get_summary):
        get_summary.return_value = {
            "period": "2026-08",
            "household": {"id": "family-main", "name": "わが家", "owner_email": "owner@example.com"},
            "usage": {},
            "costs": {"payment_amount_jpy": 20},
            "payment": {"method": "PayPay", "qr_configured": False},
        }
        response = self.client.get("/api/billing/summary?period=2026-08")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["costs"]["payment_amount_jpy"], 20)

    def test_member_cannot_view_household_billing(self):
        app.dependency_overrides[require_authorized_user] = lambda: AuthenticatedUser(
            subject="member",
            email="member@example.com",
            household_id="family-main",
            household_name="わが家",
            household_role="member",
        )
        response = self.client.get("/api/billing/summary?period=2026-08")
        self.assertEqual(response.status_code, 403)


    @patch("app.api.endpoints.update_household_billing")
    def test_admin_can_zero_another_household_balance(self, update_billing):
        app.dependency_overrides[require_authorized_user] = lambda: AuthenticatedUser(
            subject="admin",
            email="admin@example.com",
            is_admin=True,
            household_id="admin-home",
            household_name="管理者家計簿",
            household_role="owner",
        )
        update_billing.return_value = {
            "period": "2026-08",
            "household": {"id": "friend-home"},
            "usage": {},
            "costs": {"payment_amount_jpy": 20},
            "balance": {"outstanding_balance_jpy": 0, "usage_limit_jpy": 1000},
            "payment": {},
        }
        response = self.client.patch(
            "/api/admin/billing/households/friend-home",
            json={"usage_limit_jpy": 1000, "outstanding_balance_jpy": 0, "note": "支払確認"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["balance"]["outstanding_balance_jpy"], 0)
        self.assertEqual(update_billing.call_args.args[0], "friend-home")
        self.assertEqual(update_billing.call_args.kwargs["outstanding_balance_jpy"], 0)

if __name__ == "__main__":
    unittest.main()
