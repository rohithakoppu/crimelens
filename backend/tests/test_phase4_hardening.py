"""Phase 4: authorization tightening + upload size enforcement.

Pure/unit-level tests -- no live Firestore/Algorand required.
"""
import asyncio

import pytest
from fastapi import HTTPException

from api.evidence import USER_TRIGGERABLE_CUSTODY_ACTIONS, _read_upload_within_limit


# --------------------------------------------- custody action allowlist --

def test_system_generated_events_cannot_be_spoofed_via_custody_endpoint():
    """A client must never be able to POST /evidence/{id}/custody with an
    action like BLOCKCHAIN_ANCHORED or SEGMENT_CREATED and have it look
    identical to a real system-generated custody entry."""
    # Note: ACCESSED is intentionally excluded from this set -- it's real
    # both ways (the system logs it automatically on file playback, AND a
    # user can manually log it as "I looked at this"), not a spoofable
    # system-internal event like the ones below.
    system_only_events = {
        "EVIDENCE_CREATED", "HASH_GENERATED", "SIGNED", "ENCRYPTED", "STORED",
        "STORAGE_UNAVAILABLE", "SEGMENT_CREATED", "BLOCKCHAIN_ANCHORED",
        "BLOCKCHAIN_ANCHOR_FAILED", "BLOCKCHAIN_ANCHOR_SKIPPED",
        "VERIFICATION_REQUESTED", "DERIVED_COPY_CREATED", "DERIVED_FROM_ORIGINAL",
    }
    assert USER_TRIGGERABLE_CUSTODY_ACTIONS.isdisjoint(system_only_events)


def test_user_triggerable_actions_are_the_documented_set():
    assert USER_TRIGGERABLE_CUSTODY_ACTIONS == {"ACCESSED", "EXPORTED", "TRANSFERRED", "ANALYZED"}


# ------------------------------------------------------- upload size cap --

class _FakeUploadFile:
    """Minimal async-read stand-in for FastAPI's UploadFile, chunked like a
    real multipart upload would be."""

    def __init__(self, data: bytes, chunk_size: int = 1024 * 1024):
        self._data = data
        self._chunk_size = chunk_size
        self._pos = 0

    async def read(self, n: int = -1) -> bytes:
        # Caps each read at self._chunk_size regardless of what the caller
        # requested, like a real network stream that may return less than
        # asked for -- lets tests prove the size check trips mid-stream.
        requested = n if n and n > 0 else len(self._data) - self._pos
        size = min(requested, self._chunk_size)
        chunk = self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk


def test_upload_within_limit_succeeds(monkeypatch):
    import api.evidence as evidence_module

    class _TinyLimitSettings:
        max_upload_bytes = 1000

    monkeypatch.setattr(evidence_module, "get_settings", lambda: _TinyLimitSettings())

    data = b"x" * 500
    result = asyncio.run(_read_upload_within_limit(_FakeUploadFile(data)))
    assert result == data


def test_upload_exceeding_limit_is_rejected_with_413(monkeypatch):
    """Real, enforced ceiling -- not just a comment. Uses a small configured
    limit so the test itself doesn't need to construct 200MB of data."""
    import api.evidence as evidence_module

    class _TinyLimitSettings:
        max_upload_bytes = 1000

    monkeypatch.setattr(evidence_module, "get_settings", lambda: _TinyLimitSettings())

    oversized = b"x" * 5000
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_read_upload_within_limit(_FakeUploadFile(oversized)))
    assert exc_info.value.status_code == 413


def test_upload_limit_check_happens_incrementally_not_after_full_buffer(monkeypatch):
    """The check must trip mid-stream (chunk by chunk), not only after
    reading the entire oversized body into memory -- verified by using a
    chunk size smaller than the configured limit and confirming the
    function stops reading once the limit is crossed rather than consuming
    the whole fake stream."""
    import api.evidence as evidence_module

    class _TinyLimitSettings:
        max_upload_bytes = 2500

    monkeypatch.setattr(evidence_module, "get_settings", lambda: _TinyLimitSettings())

    fake = _FakeUploadFile(b"y" * 10_000, chunk_size=1000)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_read_upload_within_limit(fake))
    assert exc_info.value.status_code == 413
    # Stopped well before consuming the entire 10,000-byte fake stream.
    assert fake._pos < 10_000
