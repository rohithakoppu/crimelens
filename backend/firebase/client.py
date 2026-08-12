"""Firebase Admin SDK bootstrap: Firestore + Storage + Auth.

This is the ONLY place firebase_admin.initialize_app is called. If no valid
service account is configured, `is_configured()` returns False and every
caller must treat that as a real "unavailable" state -- there is no
in-memory or fake fallback that pretends to be Firestore/Storage.
"""
import json
import os
from functools import lru_cache

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials, firestore, storage


class FirebaseUnavailableError(RuntimeError):
    pass


class FirebaseClient:
    def __init__(self):
        from config import get_settings

        s = get_settings()
        self.settings = s
        self._configured = False
        self._app = None
        self.db = None
        self.bucket = None
        self.error = None

        cred = self._load_credential(s)
        if cred is not None and s.firebase_project_id:
            try:
                self._app = firebase_admin.initialize_app(
                    cred,
                    {"projectId": s.firebase_project_id, "storageBucket": s.firebase_storage_bucket},
                    name="evidencechain",
                )
                self.db = firestore.client(self._app)
                if s.firebase_storage_bucket:
                    self.bucket = storage.bucket(app=self._app)
                self._configured = True
            except ValueError:
                # app already initialized (e.g. reload) -- reuse it
                self._app = firebase_admin.get_app(name="evidencechain")
                self.db = firestore.client(self._app)
                if s.firebase_storage_bucket:
                    self.bucket = storage.bucket(app=self._app)
                self._configured = True
            except Exception as exc:
                self.error = str(exc)
                self._configured = False
        else:
            self.error = "No Firebase service account / project ID configured"

    @staticmethod
    def _load_credential(s):
        try:
            if s.firebase_service_account_json.strip():
                info = json.loads(s.firebase_service_account_json)
                return credentials.Certificate(info)
        except Exception:
            pass
        try:
            path = s.firebase_service_account_path
            if path and os.path.exists(path):
                return credentials.Certificate(path)
        except Exception:
            pass
        return None

    def is_configured(self) -> bool:
        return self._configured

    def require_ready(self):
        if not self._configured:
            raise FirebaseUnavailableError(f"Firebase not configured: {self.error or 'unknown reason'}")

    def verify_id_token(self, token: str) -> dict:
        self.require_ready()
        return fb_auth.verify_id_token(token, app=self._app)

    def get_or_create_auth_user(self, email: str, password: str, display_name: str) -> str:
        self.require_ready()
        try:
            user = fb_auth.get_user_by_email(email, app=self._app)
            return user.uid
        except fb_auth.UserNotFoundError:
            user = fb_auth.create_user(
                email=email, password=password, display_name=display_name, app=self._app
            )
            return user.uid

    def status(self) -> dict:
        return {"configured": self._configured, "project_id": self.settings.firebase_project_id, "error": self.error}


@lru_cache
def get_firebase_client() -> FirebaseClient:
    return FirebaseClient()
