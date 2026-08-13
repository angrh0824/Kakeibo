import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.auth import AuthenticatedUser
from app.config import settings
from app.models import HouseholdInviteCreate
from app.services.image_storage import upload_receipt_image
from app.services.tenant_service import authorize_identity, require_household_owner


class _FakeBlob:
    def upload_from_string(self, content, content_type):
        self.content = content
        self.content_type = content_type


class _FakeBucket:
    def __init__(self):
        self.object_name = ""

    def blob(self, object_name):
        self.object_name = object_name
        return _FakeBlob()


class _FakeStorageClient:
    def __init__(self):
        self.value = _FakeBucket()

    def bucket(self, bucket_name):
        return self.value


class TenantAccessTests(unittest.TestCase):
    def test_local_identity_receives_legacy_household_context(self):
        identity = AuthenticatedUser(subject="local", email="local@example.com", name="Local")
        with patch.object(settings, "AUTH_REQUIRED", False):
            user = authorize_identity(identity)
        self.assertEqual(user.household_id, "family-main")
        self.assertEqual(user.household_role, "owner")
        self.assertTrue(user.is_admin)

    def test_platform_admin_cannot_invite_to_household_without_owner_role(self):
        admin = AuthenticatedUser(
            subject="admin", email="admin@example.com", is_admin=True,
            household_id="friend-home", household_role="member"
        )
        with self.assertRaises(HTTPException) as raised:
            require_household_owner(admin)
        self.assertEqual(raised.exception.status_code, 403)

    def test_invitation_email_is_normalized(self):
        invite = HouseholdInviteCreate(email="  Friend@Example.COM ")
        self.assertEqual(invite.email, "friend@example.com")

    @patch("app.services.image_storage._storage_client")
    def test_receipt_image_path_is_namespaced_by_household(self, storage_client):
        fake = _FakeStorageClient()
        storage_client.return_value = fake
        with patch.object(settings, "GCS_BUCKET_NAME", "private-bucket"):
            result = upload_receipt_image(b"jpeg-data", "personal-friend")
        self.assertTrue(result["object_name"].startswith("receipts/personal-friend/"))
        self.assertEqual(fake.value.object_name, result["object_name"])


if __name__ == "__main__":
    unittest.main()
