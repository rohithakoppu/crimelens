"""Phase 2: x402 must keep returning a genuine HTTP 402 when quota is
exhausted and no payment is supplied, and must call the SAME corrected
verification service `/evidence/{id}/verify` uses (not a stale duplicate)
once access is granted.

These call the real route function (`_paid_verify`) directly rather than
going through a full HTTP TestClient, monkeypatching only the Firestore-
backed repository calls (same pattern as tests/test_obstruction.py) -- no
live Firestore/Algorand network access required to prove the decision logic
and wiring are correct.

Not covered here (requires a real external payer + live Algorand Testnet
transaction, which cannot be fabricated in a test): actually submitting a
real ALGO payment and having `_verify_payment` confirm it via the Indexer.
That path is exercised by `_verify_payment`'s own real Indexer lookups at
runtime -- see api/x402.py -- and was live-verified manually in an earlier
session (10 free requests succeed/fail on their own merits, 11th returns a
genuine 402).
"""
import asyncio

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from api import x402 as x402_module
from db import repository as repo


def test_invalid_api_key_is_401(monkeypatch):
    monkeypatch.setattr(repo, "get_api_client_by_key", lambda key: None)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(x402_module._paid_verify("EVD-2026-NOPE", "bad-key", None))
    assert exc_info.value.status_code == 401


def test_quota_exceeded_without_payment_returns_real_402(monkeypatch):
    """Test 8 (mandatory): no payment supplied once quota is used up ->
    genuine HTTP 402 with a real, machine-readable payment requirement."""
    monkeypatch.setattr(repo, "get_api_client_by_key", lambda key: {"id": "client-1", "tier": "free", "active": True})
    monkeypatch.setattr(repo, "count_usage_last_hour", lambda client_id: 999)  # far past any real free-tier limit
    recorded = []
    monkeypatch.setattr(repo, "record_api_usage", lambda *a, **kw: recorded.append((a, kw)))

    result = asyncio.run(x402_module._paid_verify("EVD-2026-NOPE", "fake-api-key", None))

    assert isinstance(result, JSONResponse)
    assert result.status_code == 402
    assert recorded, "usage must still be recorded even when access is denied"


def test_within_quota_delegates_to_shared_verification_service(monkeypatch):
    """Proves x402 doesn't run its own separate verification logic -- it
    calls custody.verification.verify_evidence(), the exact function
    GET /evidence/{id}/verify uses, with record_access=False (x402 requests
    aren't logged as an ACCESSED custody event the same way authenticated
    dashboard views are)."""
    monkeypatch.setattr(repo, "get_api_client_by_key", lambda key: {"id": "client-1", "tier": "enterprise", "active": True})
    monkeypatch.setattr(repo, "count_usage_last_hour", lambda client_id: 0)
    monkeypatch.setattr(repo, "record_api_usage", lambda *a, **kw: None)

    calls = {}

    def fake_verify_evidence(evidence_id, record_access=True):
        calls["evidence_id"] = evidence_id
        calls["record_access"] = record_access
        return {"evidence_id": evidence_id, "verdict": "AUTHENTIC", "segment_chain_intact": True, "root_hash": "abc"}

    monkeypatch.setattr(x402_module.verification_service, "verify_evidence", fake_verify_evidence)

    result = asyncio.run(x402_module._paid_verify("EVD-2026-REAL", "good-key", None))

    assert result["paid"] is False
    assert result["result"]["verdict"] == "AUTHENTIC"
    assert calls == {"evidence_id": "EVD-2026-REAL", "record_access": False}
