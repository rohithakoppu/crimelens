"""Phase 2: unified verification verdict logic + Evidence Root Hash.

Tested via the pure (no-Firestore) pieces -- _determine_verdict() and
compute_root_hash() take plain data in, return plain data out. Same
functions verify_evidence() calls against live Firestore/storage.
"""
from custody.segments import GENESIS_HASH, build_segment, verify_segments
from custody.verification import _determine_verdict, compute_root_hash


def _build_chain(evidence_id="EVD-2026-VERIFY-TEST"):
    s0 = build_segment(evidence_id=evidence_id, sequence=0, sha256_hex="a" * 64, duration_seconds=5.0,
                        prev_hash=GENESIS_HASH, storage_status="STORED")
    s1 = build_segment(evidence_id=evidence_id, sequence=1, sha256_hex="b" * 64, duration_seconds=5.0,
                        prev_hash=s0["segment_hash"], storage_status="STORED")
    s2 = build_segment(evidence_id=evidence_id, sequence=2, sha256_hex="c" * 64, duration_seconds=4.2,
                        prev_hash=s1["segment_hash"], storage_status="STORED")
    return [s0, s1, s2]


# --------------------------------------------------------------- verdict --

def test_all_checks_pass_is_authentic():
    verdict, reason, failed_seg = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=True,
        segment_status={"intact": True, "segment_count": 3, "broken_at": None},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "AUTHENTIC"
    assert reason is None
    assert failed_seg is None


def test_root_file_hash_mismatch_is_tampered_hash_mismatch():
    """Test 2: modified root/original payload -- direct evidence tampering."""
    verdict, reason, _ = _determine_verdict(
        hash_match=False, signature_valid=True, custody_intact=True,
        segment_status={"intact": True, "segment_count": 3, "broken_at": None},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "TAMPERED"
    assert reason == "HASH_MISMATCH"


def test_invalid_signature_is_tampered():
    verdict, reason, _ = _determine_verdict(
        hash_match=True, signature_valid=False, custody_intact=True,
        segment_status={"intact": True, "segment_count": 3, "broken_at": None},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "TAMPERED"
    assert reason == "SIGNATURE_INVALID"


def test_broken_custody_chain_is_integrity_failure():
    verdict, reason, _ = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=False,
        segment_status={"intact": True, "segment_count": 3, "broken_at": None},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "INTEGRITY_FAILURE"
    assert reason == "CUSTODY_CHAIN_BROKEN"


def test_missing_segment_is_integrity_failure_with_failed_segment():
    """Test 3: a gap in the sequence (001, 002, 004) -- missing segment 003."""
    verdict, reason, failed_seg = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=True,
        segment_status={"intact": False, "segment_count": 2,
                         "broken_at": {"sequence": 2, "reason": "sequence_gap", "expected_sequence": 2}},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "INTEGRITY_FAILURE"
    assert reason == "MISSING_SEGMENT"
    assert failed_seg == 2


def test_reordered_segment_is_integrity_failure_segment_order_invalid():
    """Test 4: reordering breaks prev-hash linkage, not sequence numbering."""
    verdict, reason, _ = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=True,
        segment_status={"intact": False, "segment_count": 3,
                         "broken_at": {"sequence": 1, "reason": "prev_hash_mismatch"}},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "INTEGRITY_FAILURE"
    assert reason == "SEGMENT_ORDER_INVALID"


def test_segment_payload_hash_mismatch_is_integrity_failure():
    verdict, reason, failed_seg = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=True,
        segment_status={"intact": False, "segment_count": 3,
                         "broken_at": {"sequence": 1, "reason": "segment_hash_mismatch"}},
        root_hash_checked=True, root_hash_match=True,
    )
    assert verdict == "INTEGRITY_FAILURE"
    assert reason == "SEGMENT_HASH_MISMATCH"
    assert failed_seg == 1


def test_root_hash_mismatch_alone_is_integrity_failure():
    verdict, reason, _ = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=True,
        segment_status={"intact": True, "segment_count": 3, "broken_at": None},
        root_hash_checked=True, root_hash_match=False,
    )
    assert verdict == "INTEGRITY_FAILURE"
    assert reason == "ROOT_HASH_MISMATCH"


def test_unchecked_root_hash_does_not_block_authentic():
    """Legacy evidence with no stored root_hash (ingested before Phase 2, or
    zero segments) must not fail integrity on that alone."""
    verdict, reason, _ = _determine_verdict(
        hash_match=True, signature_valid=True, custody_intact=True,
        segment_status={"intact": True, "segment_count": 0, "broken_at": None},
        root_hash_checked=False, root_hash_match=False,
    )
    assert verdict == "AUTHENTIC"
    assert reason is None


def test_verdict_logic_has_no_blockchain_parameter():
    """Test 7 (contract-level): blockchain status literally cannot affect
    this function, because it isn't a parameter -- an unfunded/unreachable
    Algorand account can never turn AUTHENTIC evidence into TAMPERED."""
    import inspect

    params = inspect.signature(_determine_verdict).parameters
    assert not any("blockchain" in p.lower() or "algorand" in p.lower() for p in params)


# ------------------------------------------------------------- root hash --

def test_root_hash_is_deterministic():
    """Test 5: same evidence (same segments) -> same root hash, every time."""
    segments = _build_chain()
    h1 = compute_root_hash("EVD-2026-VERIFY-TEST", segments)
    h2 = compute_root_hash("EVD-2026-VERIFY-TEST", segments)
    assert h1 == h2
    assert len(h1) == 64  # hex-encoded SHA-256


def test_root_hash_is_sensitive_to_a_changed_segment():
    """Test 6: changing one segment's payload hash changes the root hash."""
    segments = _build_chain()
    original_root = compute_root_hash("EVD-2026-VERIFY-TEST", segments)

    tampered = [dict(s) for s in segments]
    tampered[1]["sha256"] = "f" * 64  # simulate a modified segment payload
    tampered_root = compute_root_hash("EVD-2026-VERIFY-TEST", tampered)

    assert tampered_root != original_root


def test_root_hash_changes_when_a_segment_is_missing():
    segments = _build_chain()
    full_root = compute_root_hash("EVD-2026-VERIFY-TEST", segments)
    missing_root = compute_root_hash("EVD-2026-VERIFY-TEST", [segments[0], segments[2]])
    assert missing_root != full_root


def test_root_hash_changes_when_segments_are_reordered():
    segments = _build_chain()
    ordered_root = compute_root_hash("EVD-2026-VERIFY-TEST", segments)
    reordered_root = compute_root_hash("EVD-2026-VERIFY-TEST", [segments[0], segments[2], segments[1]])
    assert reordered_root != ordered_root


def test_root_hash_none_for_empty_segment_list():
    assert compute_root_hash("EVD-2026-EMPTY", []) is None


def test_root_hash_matches_real_segment_chain_verification():
    """Sanity cross-check: the real chain used for the root hash must itself
    verify as intact -- proves the fixture in this file is a valid chain,
    not an accidentally-broken one that happens to still hash consistently."""
    segments = _build_chain()
    assert verify_segments(segments)["intact"] is True
