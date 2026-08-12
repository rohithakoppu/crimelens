"""Firestore-backed data access. Replaces the old SQLAlchemy/Postgres layer.

Every function here requires a configured Firebase project (raises
FirebaseUnavailableError otherwise, via get_firebase_client().require_ready())
-- there is no in-memory fallback, because a fallback would silently produce
fake "successful" reads/writes.
"""
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from firebase.client import get_firebase_client


def _db():
    client = get_firebase_client()
    client.require_ready()
    return client.db


# ---------------------------------------------------------------- users ----

def create_user(uid: str, name: str, email: str, role: str) -> dict:
    doc = {
        "name": name, "email": email, "role": role,
        "mfa_secret": None, "mfa_enabled": False,
        "created_at": datetime.now(timezone.utc),
    }
    _db().collection("users").document(uid).set(doc)
    return {"id": uid, **doc}


def get_user(uid: str) -> dict | None:
    snap = _db().collection("users").document(uid).get()
    if not snap.exists:
        return None
    return {"id": snap.id, **snap.to_dict()}


def get_user_by_email(email: str) -> dict | None:
    docs = list(_db().collection("users").where("email", "==", email).limit(1).stream())
    if not docs:
        return None
    return {"id": docs[0].id, **docs[0].to_dict()}


def list_users() -> list[dict]:
    return [{"id": d.id, **d.to_dict()} for d in _db().collection("users").stream()]


def set_mfa(uid: str, secret: str, enabled: bool):
    _db().collection("users").document(uid).update({"mfa_secret": secret, "mfa_enabled": enabled})


# ---------------------------------------------------------------- cases ----

def create_case(case_id: str, title: str, created_by: str | None) -> dict:
    doc = {"title": title, "status": "open", "created_by": created_by, "created_at": datetime.now(timezone.utc)}
    _db().collection("cases").document(case_id).set(doc)
    return {"case_id": case_id, **doc}


def get_case(case_id: str) -> dict | None:
    snap = _db().collection("cases").document(case_id).get()
    if not snap.exists:
        return None
    return {"case_id": snap.id, **snap.to_dict()}


def list_cases() -> list[dict]:
    return [{"case_id": d.id, **d.to_dict()} for d in _db().collection("cases").stream()]


# -------------------------------------------------------------- cameras ----

def register_camera(camera_id: str, name: str, source_type: str, case_id: str | None,
                     owner_id: str | None) -> dict:
    """`source_type` records which CameraSource implementation produced this
    camera -- 'web' today (browser getUserMedia), 'rtsp'/'onvif' reserved for
    a real NVR/CCTV integration later. The evidence pipeline itself doesn't
    care which one it is."""
    doc = {
        "name": name, "source_type": source_type, "case_id": case_id, "owner_id": owner_id,
        "status": "REGISTERED", "created_at": datetime.now(timezone.utc),
    }
    _db().collection("cameras").document(camera_id).set(doc)
    return {"camera_id": camera_id, **doc}


def get_camera(camera_id: str) -> dict | None:
    snap = _db().collection("cameras").document(camera_id).get()
    if not snap.exists:
        return None
    return {"camera_id": snap.id, **snap.to_dict()}


def list_cameras(owner_id: str | None = None) -> list[dict]:
    q = _db().collection("cameras")
    if owner_id:
        q = q.where("owner_id", "==", owner_id)
    return [{"camera_id": d.id, **d.to_dict()} for d in q.stream()]


# ------------------------------------------------------------- incidents ---

def create_incident(*, camera_id: str, case_id: str | None, incident_type: str, severity: str,
                     camera_event_id: str | None, metadata: dict | None = None) -> dict:
    doc = {
        "camera_id": camera_id, "case_id": case_id, "incident_type": incident_type, "severity": severity,
        "camera_event_id": camera_event_id, "status": "OPEN", "metadata": metadata or {},
        "created_at": datetime.now(timezone.utc), "resolved_at": None,
    }
    ref = _db().collection("incidents").document()
    ref.set(doc)
    return {"id": ref.id, **doc}


def resolve_incident(incident_id: str, resolution_metadata: dict | None = None) -> dict:
    ref = _db().collection("incidents").document(incident_id)
    ref.update({"status": "RESOLVED", "resolved_at": datetime.now(timezone.utc),
                "resolution_metadata": resolution_metadata or {}})
    snap = ref.get()
    return {"id": snap.id, **snap.to_dict()}


def list_incidents(case_id: str | None = None, limit: int = 200) -> list[dict]:
    q = _db().collection("incidents")
    if case_id:
        q = q.where("case_id", "==", case_id)
    docs = q.order_by("created_at", direction="DESCENDING").limit(limit).stream()
    return [{"id": d.id, **d.to_dict()} for d in docs]


# ------------------------------------------------------------- evidence ----

def create_evidence(evidence_id: str, **fields) -> dict:
    fields.setdefault("ingested_at", datetime.now(timezone.utc))
    fields.setdefault("blockchain_status", "PENDING")
    fields.setdefault("revoked", False)
    _db().collection("evidence").document(evidence_id).set(fields)
    return {"evidence_id": evidence_id, **fields}


def get_evidence(evidence_id: str) -> dict | None:
    snap = _db().collection("evidence").document(evidence_id).get()
    if not snap.exists:
        return None
    return {"evidence_id": snap.id, **snap.to_dict()}


def update_evidence(evidence_id: str, **fields):
    _db().collection("evidence").document(evidence_id).update(fields)


def list_evidence_for_case(case_id: str) -> list[dict]:
    docs = _db().collection("evidence").where("case_id", "==", case_id).stream()
    return [{"evidence_id": d.id, **d.to_dict()} for d in docs]


def list_all_evidence() -> list[dict]:
    return [{"evidence_id": d.id, **d.to_dict()} for d in _db().collection("evidence").stream()]


# ------------------------------------------------------------ ai results ---

def add_ai_result(evidence_id: str, result_type: str, result_json: dict, result_hash: str | None) -> dict:
    doc = {
        "result_type": result_type, "result_json": result_json, "result_hash": result_hash,
        "created_at": datetime.now(timezone.utc),
    }
    ref = _db().collection("evidence").document(evidence_id).collection("ai_results").document()
    ref.set(doc)
    return {"id": ref.id, **doc}


def list_ai_results(evidence_id: str) -> list[dict]:
    docs = (
        _db().collection("evidence").document(evidence_id).collection("ai_results")
        .order_by("created_at", direction="DESCENDING").stream()
    )
    return [{"id": d.id, **d.to_dict()} for d in docs]


# --------------------------------------------------------- camera events ---

def create_camera_event(camera_id: str, event_type: str, confidence: int | None, metadata: dict | None) -> dict:
    doc = {
        "camera_id": camera_id, "event_type": event_type, "status": "OPEN", "confidence": confidence,
        "started_at": datetime.now(timezone.utc), "ended_at": None, "downtime_seconds": None,
        "metadata": metadata or {},
    }
    ref = _db().collection("camera_events").document()
    ref.set(doc)
    return {"id": ref.id, **doc}


def get_open_obstruction_event(camera_id: str) -> dict | None:
    docs = list(
        _db().collection("camera_events")
        .where("camera_id", "==", camera_id)
        .where("event_type", "==", "OBSTRUCTION_DETECTED")
        .where("status", "==", "OPEN")
        .limit(1)
        .stream()
    )
    if not docs:
        return None
    return {"id": docs[0].id, **docs[0].to_dict()}


def close_camera_event(event_id: str, downtime_seconds: float) -> dict:
    ref = _db().collection("camera_events").document(event_id)
    updates = {"status": "CLOSED", "ended_at": datetime.now(timezone.utc), "downtime_seconds": downtime_seconds}
    ref.update(updates)
    snap = ref.get()
    return {"id": snap.id, **snap.to_dict()}


def list_camera_events(camera_id: str | None = None, limit: int = 100) -> list[dict]:
    q = _db().collection("camera_events")
    if camera_id:
        q = q.where("camera_id", "==", camera_id)
    docs = q.order_by("started_at", direction="DESCENDING").limit(limit).stream()
    return [{"id": d.id, **d.to_dict()} for d in docs]


# ------------------------------------------------------- x402 / api keys ---

def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def create_api_client(name: str, tier: str) -> dict:
    client_id = uuid.uuid4().hex
    raw_key = "eca_" + secrets.token_urlsafe(32)
    doc = {
        "name": name, "tier": tier, "key_hash": _hash_key(raw_key), "key_prefix": raw_key[:10],
        "created_at": datetime.now(timezone.utc), "active": True,
    }
    _db().collection("api_clients").document(client_id).set(doc)
    response = {"id": client_id, "api_key": raw_key, **doc}  # raw_key only ever returned this once
    response.pop("key_hash", None)  # never echo the hash back over the API, even to an admin
    return response


def get_api_client_by_key(raw_key: str) -> dict | None:
    docs = list(_db().collection("api_clients").where("key_hash", "==", _hash_key(raw_key)).limit(1).stream())
    if not docs:
        return None
    return {"id": docs[0].id, **docs[0].to_dict()}


def get_api_client(client_id: str) -> dict | None:
    snap = _db().collection("api_clients").document(client_id).get()
    if not snap.exists:
        return None
    return {"id": snap.id, **snap.to_dict()}


def list_api_clients() -> list[dict]:
    out = []
    for d in _db().collection("api_clients").stream():
        doc = d.to_dict()
        doc.pop("key_hash", None)
        out.append({"id": d.id, **doc})
    return out


def record_api_usage(client_id: str | None, endpoint: str, status: str, paid_with_txid: str | None = None) -> dict:
    doc = {
        "client_id": client_id, "endpoint": endpoint, "status": status,
        "paid_with_txid": paid_with_txid, "timestamp": datetime.now(timezone.utc),
    }
    ref = _db().collection("api_usage").document()
    ref.set(doc)
    return {"id": ref.id, **doc}


def count_usage_last_hour(client_id: str) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    docs = (
        _db().collection("api_usage")
        .where("client_id", "==", client_id)
        .where("status", "==", "granted")
        .where("timestamp", ">=", cutoff)
        .stream()
    )
    return sum(1 for _ in docs)


def list_usage_for_client(client_id: str, limit: int = 100) -> list[dict]:
    docs = (
        _db().collection("api_usage").where("client_id", "==", client_id)
        .order_by("timestamp", direction="DESCENDING").limit(limit).stream()
    )
    return [{"id": d.id, **d.to_dict()} for d in docs]


# ----------------------------------------------------------- x402 / pay ----

def create_payment_record(txid: str, resource: str, amount_microalgos: int, client_id: str | None) -> dict:
    doc = {
        "resource": resource, "amount_microalgos": amount_microalgos, "client_id": client_id,
        "status": "PENDING", "created_at": datetime.now(timezone.utc), "settled_at": None,
    }
    _db().collection("payment_records").document(txid).set(doc)
    return {"txid": txid, **doc}


def get_payment_record(txid: str) -> dict | None:
    snap = _db().collection("payment_records").document(txid).get()
    if not snap.exists:
        return None
    return {"txid": snap.id, **snap.to_dict()}


def mark_payment_settled(txid: str, payer_address: str) -> dict:
    ref = _db().collection("payment_records").document(txid)
    ref.update({"status": "SETTLED", "settled_at": datetime.now(timezone.utc), "payer_address": payer_address})
    snap = ref.get()
    return {"txid": snap.id, **snap.to_dict()}
