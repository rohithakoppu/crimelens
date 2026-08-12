"""Video segment hash-chain: splits a recording into sequential segments,
each hashed and cryptographically linked to the previous one -- so removing,
reordering, or altering any segment (not just the whole file) is detectable.

Same algorithm shape as custody/chain.py (append-only, GENESIS-rooted,
prev-hash-committed), applied to segments instead of custody actions:

    GENESIS -> seg[0] -> seg[1] -> seg[2] -> ... -> seg[n]

Segment bytes are hashed here regardless of whether the segment's file bytes
could actually be written to local evidence storage -- the hash chain is real
and verifiable independent of storage availability. `storage_status` on each
segment records the real write outcome (STORED / UNAVAILABLE), never faked.
"""
import hashlib
import json
from datetime import datetime, timezone

from firebase.client import get_firebase_client

GENESIS_HASH = "0" * 64


def _canonical(evidence_id: str, sequence: int, sha256_hex: str, duration_seconds: float,
               prev_hash: str) -> bytes:
    payload = {
        "evidence_id": evidence_id,
        "sequence": sequence,
        "sha256": sha256_hex,
        "duration_seconds": duration_seconds,
        "prev_segment_hash": prev_hash,
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def compute_segment_hash(evidence_id: str, sequence: int, sha256_hex: str, duration_seconds: float,
                          prev_hash: str) -> str:
    return hashlib.sha256(_canonical(evidence_id, sequence, sha256_hex, duration_seconds, prev_hash)).hexdigest()


def _segments_collection(evidence_id: str):
    client = get_firebase_client()
    client.require_ready()
    return client.db.collection("evidence").document(evidence_id).collection("segments")


def _ordered_segments(evidence_id: str) -> list[dict]:
    docs = _segments_collection(evidence_id).order_by("sequence", direction="ASCENDING").stream()
    return [{"id": d.id, **d.to_dict()} for d in docs]


def build_segment(*, evidence_id: str, sequence: int, sha256_hex: str, duration_seconds: float,
                   prev_hash: str, storage_status: str, storage_path: str | None = None,
                   storage_error: str | None = None, file_size: int | None = None,
                   mime_type: str | None = None, created_at: datetime | None = None) -> dict:
    """Pure constructor (no Firestore I/O), mirroring custody.build_event --
    used both by append_segment() and directly by tests."""
    created_at = created_at or datetime.now(timezone.utc)
    segment_hash = compute_segment_hash(evidence_id, sequence, sha256_hex, duration_seconds, prev_hash)
    return {
        "evidence_id": evidence_id, "sequence": sequence, "sha256": sha256_hex,
        "duration_seconds": duration_seconds, "file_size": file_size, "mime_type": mime_type,
        "storage_status": storage_status, "storage_path": storage_path, "storage_error": storage_error,
        "prev_segment_hash": prev_hash, "segment_hash": segment_hash, "created_at": created_at,
    }


def append_segment(*, evidence_id: str, sha256_hex: str, duration_seconds: float, storage_status: str,
                    storage_path: str | None = None, storage_error: str | None = None,
                    file_size: int | None = None, mime_type: str | None = None) -> dict:
    existing = _ordered_segments(evidence_id)
    sequence = len(existing)
    prev_hash = existing[-1]["segment_hash"] if existing else GENESIS_HASH

    doc = build_segment(
        evidence_id=evidence_id, sequence=sequence, sha256_hex=sha256_hex, duration_seconds=duration_seconds,
        prev_hash=prev_hash, storage_status=storage_status, storage_path=storage_path,
        storage_error=storage_error, file_size=file_size, mime_type=mime_type,
    )
    ref = _segments_collection(evidence_id).document(f"{sequence:06d}")
    ref.set(doc)
    return {"id": ref.id, **doc}


def list_segments(evidence_id: str) -> list[dict]:
    return _ordered_segments(evidence_id)


def verify_segments(segments: list[dict]) -> dict:
    """Pure function: recomputes each segment's hash from its stored fields
    and checks prev-hash linkage and sequence continuity. Used both by
    verify_segment_chain() (Firestore) and directly by tests."""
    if not segments:
        return {"intact": True, "segment_count": 0, "broken_at": None}

    expected_prev = GENESIS_HASH
    for i, seg in enumerate(segments):
        if seg.get("sequence") != i:
            return {
                "intact": False, "segment_count": len(segments),
                "broken_at": {"sequence": seg.get("sequence"), "reason": "sequence_gap",
                              "expected_sequence": i},
            }
        if seg.get("prev_segment_hash") != expected_prev:
            return {
                "intact": False, "segment_count": len(segments),
                "broken_at": {"sequence": seg["sequence"], "reason": "prev_hash_mismatch"},
            }
        recomputed = compute_segment_hash(
            seg["evidence_id"], seg["sequence"], seg["sha256"], seg["duration_seconds"], seg["prev_segment_hash"],
        )
        if recomputed != seg.get("segment_hash"):
            return {
                "intact": False, "segment_count": len(segments),
                "broken_at": {"sequence": seg["sequence"], "reason": "segment_hash_mismatch"},
            }
        expected_prev = seg["segment_hash"]

    return {"intact": True, "segment_count": len(segments), "broken_at": None}


def verify_segment_chain(evidence_id: str) -> dict:
    return verify_segments(_ordered_segments(evidence_id))
