"""Unified evidence verification -- the single source of truth for what
AUTHENTIC / TAMPERED / INTEGRITY_FAILURE means. Used identically by the free
public GET /evidence/{id}/verify endpoint and the paid x402 API, so the two
paths can never silently diverge on what counts as authentic.

Evidence Root Hash
------------------
Deterministic fingerprint of an evidence item's ENTIRE segment chain (see
custody/segments.py for the chain itself):

    root_hash = SHA256(canonical_json({
        "evidence_id": evidence_id,
        "segments": [ {sequence, sha256, prev_segment_hash, segment_hash}
                       for each segment, in order ],
    }))

This is reproducible by anyone from the stored segment records alone -- no
secret, no server-side-only state. It doesn't need its own Merkle-tree
construction because each segment's own `segment_hash` already recursively
commits to every prior segment (segment_hash = H(..., prev_segment_hash)),
so folding the ordered list into one more hash gives a single fixed-size
fingerprint for the whole recording. Changing, removing, reordering, or
inserting any segment changes every segment_hash from that point forward,
which changes this root hash.

The root hash is intentionally NEVER cached only at ingest time and trusted
forever -- `evidence.root_hash` in Firestore records the root hash as of the
last segment append (see api/evidence.py), and verify_evidence() below
always RECOMPUTES it from the current segment records and compares the two,
exactly like the existing original_hash/current_hash pattern for the root
file. A mismatch between stored and recomputed root hash means the segment
records themselves were altered after the fact (e.g. directly in Firestore,
bypassing this API).

Verdict layering
----------------
Cryptographic integrity (hash / signature / custody chain / segment chain /
root hash) is evaluated completely independently of blockchain anchor
status. An unfunded/unreachable Algorand account can never turn AUTHENTIC
evidence into TAMPERED -- see _determine_verdict(), which doesn't take a
blockchain parameter at all.
"""
import hashlib
import json

from custody import chain as custody
from custody import segments as segment_chain
from db import repository as repo
from storage.object_store import ObjectStoreUnavailableError, get_object_store
from utils.security import sha256_bytes, verify_evidence_signature

FAILURE_REASON_MAP = {
    "sequence_gap": "MISSING_SEGMENT",
    "prev_hash_mismatch": "SEGMENT_ORDER_INVALID",
    "segment_hash_mismatch": "SEGMENT_HASH_MISMATCH",
}


class VerificationUnavailableError(RuntimeError):
    """Raised when verification cannot run at all (e.g. the stored file
    can't be read) -- distinct from a real TAMPERED/INTEGRITY_FAILURE
    verdict, which requires actually being able to check something."""


def compute_root_hash(evidence_id: str, segments: list[dict]) -> str | None:
    """Deterministic Evidence Root Hash over the ordered segment chain.
    Returns None for evidence with no segments yet (nothing to root)."""
    if not segments:
        return None
    payload = {
        "evidence_id": evidence_id,
        "segments": [
            {
                "sequence": s["sequence"],
                "sha256": s["sha256"],
                "prev_segment_hash": s["prev_segment_hash"],
                "segment_hash": s["segment_hash"],
            }
            for s in segments
        ],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _determine_verdict(
    *, hash_match: bool, signature_valid: bool, custody_intact: bool,
    segment_status: dict, root_hash_checked: bool, root_hash_match: bool,
) -> tuple[str, str | None, int | None]:
    """Pure decision function, no I/O -- directly unit-testable. Returns
    (verdict, failure_reason, failed_segment_sequence).

    TAMPERED is reserved for direct evidence the root file itself was
    altered (hash/signature). INTEGRITY_FAILURE covers chain-level problems
    (custody, segments, root hash) -- a meaningful distinction for an
    investigator deciding what actually went wrong.
    """
    if not hash_match:
        return "TAMPERED", "HASH_MISMATCH", None
    if not signature_valid:
        return "TAMPERED", "SIGNATURE_INVALID", None
    if not custody_intact:
        return "INTEGRITY_FAILURE", "CUSTODY_CHAIN_BROKEN", None
    if not segment_status["intact"]:
        broken = segment_status.get("broken_at") or {}
        reason = FAILURE_REASON_MAP.get(broken.get("reason"), "SEGMENT_CHAIN_BROKEN")
        return "INTEGRITY_FAILURE", reason, broken.get("sequence")
    if root_hash_checked and not root_hash_match:
        return "INTEGRITY_FAILURE", "ROOT_HASH_MISMATCH", None
    return "AUTHENTIC", None, None


def _read_blockchain_state(evidence_id: str, evidence: dict, root_hash: str | None) -> dict:
    """Independent blockchain readback -- never trusts the cached Firestore
    `blockchain_status` field alone. Prefers the real Phase 3 smart-contract
    box (compares the LOCAL recomputed root_hash against the ACTUAL on-chain
    value) when the contract is configured; falls back to the legacy Phase
    1/2 note-based anchor for evidence registered before Phase 3 existed.
    Never returns "verified": True without a real, independently-fetched
    on-chain value to compare against.
    """
    from blockchain.algorand.client import AlgorandUnavailableError, get_algorand_client
    from blockchain.algorand import contract as contract_service
    from blockchain.algorand.contract import ContractNotConfiguredError

    if evidence.get("algorand_app_id") is not None and root_hash:
        try:
            onchain = contract_service.get_evidence_from_contract(evidence_id)
        except ContractNotConfiguredError as exc:
            return {"checked": False, "verified": False, "status": "NOT_CONFIGURED", "reason": str(exc)}
        except AlgorandUnavailableError as exc:
            return {"checked": True, "verified": False, "status": "UNAVAILABLE", "reason": str(exc)}

        if onchain is None:
            return {"checked": True, "verified": False, "status": "UNAVAILABLE",
                    "reason": "No on-chain record found for this evidence_id"}

        root_hash_match_chain = onchain["root_hash"] == root_hash
        return {
            "checked": True,
            "verified": root_hash_match_chain,
            "status": "CONFIRMED" if root_hash_match_chain else "HASH_MISMATCH",
            "app_id": onchain["app_id"],
            "anchored_root_hash": onchain["root_hash"],
            "expected_root_hash": root_hash,
            "registered_at": onchain["registered_at"],
            "registrant": onchain["registrant"],
        }

    if evidence.get("algorand_txid"):
        # Legacy Phase 1/2 note-based anchor (whole-file hash, no contract)
        # -- kept working for any evidence anchored before Phase 3, never
        # removed.
        try:
            anchor_chain = get_algorand_client()
            result = anchor_chain.verify_anchor(
                txid=evidence["algorand_txid"], expected_evidence_id=evidence_id,
                expected_sha256_hex=evidence["sha256"],
            )
            return {"checked": True, "status": "CONFIRMED" if result["verified"] else "HASH_MISMATCH", **result}
        except AlgorandUnavailableError as exc:
            return {"checked": True, "verified": False, "status": "UNAVAILABLE", "reason": str(exc)}

    return {"checked": False, "verified": False, "status": "NOT_CONFIGURED", "reason": "No anchor recorded"}


def verify_evidence(evidence_id: str, *, record_access: bool = True) -> dict | None:
    """Full deterministic verification. Returns None if the evidence doesn't
    exist. Raises VerificationUnavailableError if the stored file can't be
    read (e.g. local disk write failed at ingest) -- callers turn that into
    an honest 503, never a fabricated verdict."""
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        return None

    try:
        store = get_object_store()
        raw = store.get_decrypted(evidence["storage_path"])
    except ObjectStoreUnavailableError as exc:
        raise VerificationUnavailableError(str(exc))

    current_hash = sha256_bytes(raw)
    hash_match = current_hash == evidence["sha256"]
    signature_valid = verify_evidence_signature(evidence["sha256"], evidence.get("signature") or "")

    custody_status = custody.verify_chain(evidence_id)

    segments = segment_chain.list_segments(evidence_id)
    segment_status = segment_chain.verify_segments(segments)

    root_hash = compute_root_hash(evidence_id, segments)
    stored_root_hash = evidence.get("root_hash")
    # Root hash is an additional layer on top of hash/signature/custody, not
    # a replacement -- legacy evidence with no stored root_hash (ingested
    # before this existed, or with zero segments) never fails on this check
    # alone.
    root_hash_checked = stored_root_hash is not None
    root_hash_match = root_hash_checked and root_hash == stored_root_hash

    blockchain_result = _read_blockchain_state(evidence_id, evidence, root_hash)

    verdict, failure_reason, failed_segment = _determine_verdict(
        hash_match=hash_match, signature_valid=signature_valid, custody_intact=custody_status["intact"],
        segment_status=segment_status, root_hash_checked=root_hash_checked, root_hash_match=root_hash_match,
    )

    if record_access:
        custody.append_event(evidence_id=evidence_id, event_type="VERIFICATION_REQUESTED")

    return {
        "evidence_id": evidence_id,
        "original_hash": evidence["sha256"],
        "current_hash": current_hash,
        "hash_match": hash_match,
        "signature_valid": signature_valid,
        "custody_chain": custody_status,
        "custody_chain_intact": custody_status["intact"],
        "segment_chain": segment_status,
        "segment_chain_intact": segment_status["intact"],
        "segment_count": segment_status["segment_count"],
        "root_hash": root_hash,
        "root_hash_checked": root_hash_checked,
        "root_hash_match": root_hash_match if root_hash_checked else None,
        "blockchain": blockchain_result,
        "blockchain_status": evidence.get("blockchain_status", "PENDING"),
        "blockchain_txid": evidence.get("algorand_txid"),
        "network": "algorand-testnet",
        "application_id": evidence.get("algorand_app_id") or "UNAVAILABLE",
        "transaction_id": evidence.get("algorand_txid") or "UNAVAILABLE",
        "anchored_root_hash": evidence.get("anchored_root_hash") or "UNAVAILABLE",
        "anchor_timestamp": blockchain_result.get("registered_at") or "UNAVAILABLE",
        "verification_status": blockchain_result.get("status", "NOT_CONFIGURED"),
        "verdict": verdict,
        "final_verdict": verdict,
        "failure_reason": failure_reason,
        "failed_segment": failed_segment,
    }
