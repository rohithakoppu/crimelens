"""Chain-of-custody hash-linking, tested via the pure (no-Firestore) helpers
build_event()/verify_events() -- same algorithm the live Firestore-backed
append_event()/verify_chain() use. Live Firestore persistence itself is
covered by a manual test once a real project is configured (see README).
"""
from custody.chain import GENESIS_HASH, build_event, verify_events


def _build_chain(evidence_id="EVD-2026-TEST"):
    e1 = build_event(evidence_id=evidence_id, event_type="EVIDENCE_CREATED", prev_hash=GENESIS_HASH)
    e2 = build_event(evidence_id=evidence_id, event_type="HASH_GENERATED", prev_hash=e1["event_hash"],
                      metadata={"sha256": "abc123"})
    e3 = build_event(evidence_id=evidence_id, event_type="STORED", prev_hash=e2["event_hash"])
    return [e1, e2, e3]


def test_valid_chain_is_intact():
    events = _build_chain()
    result = verify_events(events)
    assert result["intact"] is True
    assert result["event_count"] == 3
    assert result["broken_at"] is None


def test_editing_an_earlier_event_breaks_the_chain_from_that_point():
    events = _build_chain()
    # Tamper with event 2's metadata directly, as if someone edited the row
    # in the database without going through append_event.
    events[1]["metadata"] = {"sha256": "TAMPERED"}

    result = verify_events(events)
    assert result["intact"] is False
    assert result["broken_at"]["event_type"] == "HASH_GENERATED"


def test_reordering_events_breaks_prev_hash_linkage():
    events = _build_chain()
    reordered = [events[0], events[2], events[1]]  # swap event 2 and 3
    result = verify_events(reordered)
    assert result["intact"] is False


def test_empty_chain_is_trivially_intact():
    result = verify_events([])
    assert result["intact"] is True
    assert result["event_count"] == 0


def test_deleting_a_middle_event_breaks_the_chain():
    events = _build_chain()
    truncated = [events[0], events[2]]  # event 2 removed -- event 3's prev_hash now dangles
    result = verify_events(truncated)
    assert result["intact"] is False
    assert result["broken_at"]["reason"] == "prev_hash_mismatch"
