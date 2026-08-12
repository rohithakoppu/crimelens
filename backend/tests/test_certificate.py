"""Regression test for a real bug found during live testing: fpdf2's
multi_cell() leaves the cursor near the right margin instead of resetting to
the left column, so a second consecutive multi_cell() call would crash with
"Not enough horizontal space to render a single character" -- this only
surfaces once there are 2+ multi_cell calls in a row, e.g. 2+ custody
events, so it slipped past manual testing with a single event.
"""
from utils.certificate import build_certificate_pdf
from utils.security import sha256_bytes, sign_evidence_hash


def test_certificate_renders_with_no_custody_events():
    h = sha256_bytes(b"evidence bytes")
    pdf = build_certificate_pdf(
        evidence_id="EVD-2026-TEST", case_id="CASE-2026-TEST",
        original_hash=h, current_hash=h, matches=True,
        chain_tx_hash=None, blockchain_status="PENDING",
        custody_intact=True, custody_events=[],
    )
    assert pdf[:4] == b"%PDF"


def test_certificate_renders_with_multiple_custody_events():
    """The actual regression case: 2+ events in a row must not crash."""
    h = sha256_bytes(b"evidence bytes")
    sign_evidence_hash  # imported for symmetry with other crypto tests; not required here
    events = [
        {"action": a, "actor": "Officer Test", "timestamp": f"2026-08-11T00:00:0{i}"}
        for i, a in enumerate(["EVIDENCE_CREATED", "HASH_GENERATED", "SIGNED", "ENCRYPTED", "STORED", "BLOCKCHAIN_ANCHORED"])
    ]
    pdf = build_certificate_pdf(
        evidence_id="EVD-2026-TEST", case_id="CASE-2026-TEST",
        original_hash=h, current_hash=h, matches=True,
        chain_tx_hash="ABCDEF1234567890", blockchain_status="CONFIRMED",
        custody_intact=True, custody_events=events,
    )
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 1000


def test_certificate_renders_tampered_verdict():
    original = sha256_bytes(b"original file")
    tampered = sha256_bytes(b"tampered file")
    pdf = build_certificate_pdf(
        evidence_id="EVD-2026-TEST", case_id="CASE-2026-TEST",
        original_hash=original, current_hash=tampered, matches=False,
        chain_tx_hash="ABCDEF1234567890", blockchain_status="CONFIRMED",
        custody_intact=False, custody_events=[
            {"action": "EVIDENCE_CREATED", "actor": "Officer Test", "timestamp": "2026-08-11T00:00:00"},
            {"action": "ACCESSED", "actor": "Someone", "timestamp": "2026-08-11T00:01:00"},
        ],
    )
    assert pdf[:4] == b"%PDF"
