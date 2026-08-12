"""Hash-linked chain-of-custody log, stored in Firestore under
evidence/{evidence_id}/custody_events.

Every custody-relevant action on a piece of evidence appends one event.
Each event's hash commits to (evidence_id, event_type, actor, timestamp,
metadata, and the previous event's hash) -- so if anyone edits an older
document directly in Firestore, every event_hash after that point stops
matching what verify_chain() recomputes, and the break is reported with its
exact position.
"""
import hashlib
import json
from datetime import datetime, timezone

from firebase.client import get_firebase_client

GENESIS_HASH = "0" * 64


def _canonical(evidence_id: str, event_type: str, actor_id, occurred_at: datetime,
                metadata: dict | None, prev_hash: str) -> bytes:
    payload = {
        "evidence_id": evidence_id,
        "event_type": event_type,
        "actor_id": actor_id,
        "occurred_at": occurred_at.isoformat(),
        "metadata": metadata or {},
        "prev_event_hash": prev_hash,
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def compute_event_hash(evidence_id: str, event_type: str, actor_id, occurred_at: datetime,
                        metadata: dict | None, prev_hash: str) -> str:
    return hashlib.sha256(_canonical(evidence_id, event_type, actor_id, occurred_at, metadata, prev_hash)).hexdigest()


def _events_collection(evidence_id: str):
    client = get_firebase_client()
    client.require_ready()
    return client.db.collection("evidence").document(evidence_id).collection("custody_events")


def _ordered_events(evidence_id: str) -> list[dict]:
    docs = _events_collection(evidence_id).order_by("occurred_at", direction="ASCENDING").stream()
    return [{"id": d.id, **d.to_dict()} for d in docs]


def append_event(*, evidence_id: str, event_type: str, actor_id: str | None = None,
                  actor_name: str | None = None, actor_role: str | None = None,
                  metadata: dict | None = None) -> dict:
    events = _ordered_events(evidence_id)
    prev_hash = events[-1]["event_hash"] if events else GENESIS_HASH
    doc = build_event(evidence_id=evidence_id, event_type=event_type, prev_hash=prev_hash, actor_id=actor_id,
                       actor_name=actor_name, actor_role=actor_role, metadata=metadata)
    ref = _events_collection(evidence_id).document()
    ref.set(doc)
    return {"id": ref.id, **doc}


def list_events(evidence_id: str) -> list[dict]:
    return _ordered_events(evidence_id)


def verify_events(events: list[dict]) -> dict:
    """Pure function: recomputes every event's hash from its stored fields
    and checks the prev_hash linkage. Used by verify_chain() (Firestore) and
    directly by tests (in-memory event lists) -- same algorithm either way.
    """
    if not events:
        return {"intact": True, "event_count": 0, "broken_at": None}

    expected_prev = GENESIS_HASH
    for event in events:
        occurred_at = event["occurred_at"]
        if not isinstance(occurred_at, datetime):
            occurred_at = datetime.fromisoformat(str(occurred_at))

        if event.get("prev_event_hash") != expected_prev:
            return {
                "intact": False, "event_count": len(events),
                "broken_at": {"event_id": event.get("id"), "event_type": event["event_type"], "reason": "prev_hash_mismatch"},
            }
        recomputed = compute_event_hash(
            event["evidence_id"], event["event_type"], event.get("actor_id"), occurred_at,
            event.get("metadata"), event.get("prev_event_hash"),
        )
        if recomputed != event.get("event_hash"):
            return {
                "intact": False, "event_count": len(events),
                "broken_at": {"event_id": event.get("id"), "event_type": event["event_type"], "reason": "event_hash_mismatch"},
            }
        expected_prev = event["event_hash"]

    return {"intact": True, "event_count": len(events), "broken_at": None}


def build_event(*, evidence_id: str, event_type: str, prev_hash: str, actor_id: str | None = None,
                 actor_name: str | None = None, actor_role: str | None = None,
                 metadata: dict | None = None, occurred_at: datetime | None = None) -> dict:
    """Pure event constructor (no Firestore I/O) -- what append_event() would
    write, minus the network call. Used by tests to build a valid chain."""
    occurred_at = occurred_at or datetime.now(timezone.utc)
    event_hash = compute_event_hash(evidence_id, event_type, actor_id, occurred_at, metadata, prev_hash)
    return {
        "evidence_id": evidence_id, "actor_id": actor_id, "actor_name": actor_name, "actor_role": actor_role,
        "event_type": event_type, "metadata": metadata or {}, "prev_event_hash": prev_hash,
        "event_hash": event_hash, "occurred_at": occurred_at,
    }


def verify_chain(evidence_id: str) -> dict:
    return verify_events(_ordered_events(evidence_id))
