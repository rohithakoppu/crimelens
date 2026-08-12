"""Video segment hash-chain, tested via the pure (no-Firestore) helpers
build_segment()/verify_segments() -- same algorithm the live Firestore-backed
append_segment()/verify_segment_chain() use.
"""
from custody.segments import GENESIS_HASH, build_segment, verify_segments


def _build_chain(evidence_id="EVD-2026-TEST"):
    s0 = build_segment(evidence_id=evidence_id, sequence=0, sha256_hex="a" * 64, duration_seconds=5.0,
                        prev_hash=GENESIS_HASH, storage_status="STORED")
    s1 = build_segment(evidence_id=evidence_id, sequence=1, sha256_hex="b" * 64, duration_seconds=5.0,
                        prev_hash=s0["segment_hash"], storage_status="STORED")
    s2 = build_segment(evidence_id=evidence_id, sequence=2, sha256_hex="c" * 64, duration_seconds=4.2,
                        prev_hash=s1["segment_hash"], storage_status="UNAVAILABLE", storage_error="bucket 404")
    return [s0, s1, s2]


def test_valid_segment_chain_is_intact():
    segments = _build_chain()
    result = verify_segments(segments)
    assert result["intact"] is True
    assert result["segment_count"] == 3
    assert result["broken_at"] is None


def test_storage_unavailable_does_not_break_the_hash_chain():
    """The hash chain must stay verifiable even when a segment's underlying
    bytes never made it to Storage -- these are independent concerns."""
    segments = _build_chain()
    assert segments[2]["storage_status"] == "UNAVAILABLE"
    result = verify_segments(segments)
    assert result["intact"] is True


def test_modifying_a_segment_hash_breaks_the_chain_from_that_point():
    segments = _build_chain()
    segments[1]["sha256"] = "f" * 64  # simulate the underlying video bytes changing after the fact

    result = verify_segments(segments)
    assert result["intact"] is False
    assert result["broken_at"]["sequence"] == 1
    assert result["broken_at"]["reason"] == "segment_hash_mismatch"


def test_removing_a_middle_segment_breaks_the_chain():
    segments = _build_chain()
    truncated = [segments[0], segments[2]]  # segment 1 removed
    result = verify_segments(truncated)
    assert result["intact"] is False
    # sequence continuity fails first: segment[1] in the truncated list still
    # carries sequence=2, but is now at list-position 1
    assert result["broken_at"]["reason"] == "sequence_gap"


def test_reordering_segments_breaks_the_chain():
    segments = _build_chain()
    reordered = [segments[0], segments[2], segments[1]]
    result = verify_segments(reordered)
    assert result["intact"] is False


def test_empty_segment_list_is_trivially_intact():
    result = verify_segments([])
    assert result["intact"] is True
    assert result["segment_count"] == 0
