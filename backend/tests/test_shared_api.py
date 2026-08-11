import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.models import ReceiptWrite


SAMPLE = {
    "date": "2026-08-11",
    "store": "共有テスト店",
    "items": [
        {
            "name": "牛乳",
            "price": 180,
            "quantity": 1,
            "category": "食費",
            "line_total": 198,
        }
    ],
    "total": 999,
    "confidence": 0.9,
    "status": "validated",
}


class SharedReceiptApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_receipt_total_is_derived_from_tax_adjusted_lines(self):
        receipt = ReceiptWrite.model_validate(SAMPLE)
        self.assertEqual(receipt.total, 198)

    @patch("app.api.endpoints.list_receipts")
    def test_list_shared_receipts(self, list_receipts):
        list_receipts.return_value = [{"id": "r1", **ReceiptWrite.model_validate(SAMPLE).model_dump(mode="json")}]
        response = self.client.get("/api/receipts")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)

    @patch("app.api.endpoints.create_receipt")
    def test_create_shared_receipt(self, create_receipt):
        create_receipt.side_effect = lambda payload, user: {"id": "r2", **payload.model_dump(mode="json")}
        response = self.client.post("/api/receipts", json=SAMPLE)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["receipt"]["total"], 198)

    @patch("app.api.endpoints.update_receipt")
    def test_update_shared_receipt(self, update_receipt):
        update_receipt.side_effect = lambda receipt_id, payload, user: {"id": receipt_id, **payload.model_dump(mode="json")}
        response = self.client.put("/api/receipts/r1", json=SAMPLE)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["receipt"]["id"], "r1")

    @patch("app.api.endpoints.delete_receipt")
    def test_delete_shared_receipt(self, delete_receipt):
        delete_receipt.return_value = {"receipt": {"id": "r1"}, "image_deleted": True}
        response = self.client.delete("/api/receipts/r1")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["image_deleted"])

    @patch("app.api.endpoints.update_item_master")
    def test_update_shared_item_master(self, update_item_master):
        update_item_master.return_value = 2
        response = self.client.patch(
            "/api/items/master",
            json={"old_name": "牛乳", "new_name": "低脂肪乳", "category": "食費"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["affected_receipts"], 2)

    @patch("app.api.endpoints.download_receipt_image")
    @patch("app.api.endpoints.get_receipt")
    def test_private_receipt_image(self, get_receipt, download_receipt_image):
        get_receipt.return_value = {"image_storage": {"object_name": "receipts/2026/08/test.jpg"}}
        download_receipt_image.return_value = (b"jpeg", "image/jpeg")
        response = self.client.get("/api/receipts/r1/image")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"jpeg")
        self.assertEqual(response.headers["content-type"], "image/jpeg")


if __name__ == "__main__":
    unittest.main()