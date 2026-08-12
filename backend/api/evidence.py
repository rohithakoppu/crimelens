from datetime import datetime, timezone

import io

import qrcode
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from config import get_settings

from ai.detection import detect_objects, flag_weapon_alerts
from ai.tamper import run_tamper_checks
from api.deps import get_current_user, require_roles
from blockchain.algorand.client import AlgorandUnavailableError
from blockchain.algorand import contract as contract_service
from blockchain.algorand.contract import ContractNotConfiguredError, EvidenceAlreadyRegisteredError
from custody import chain as custody
from custody import segments as segment_chain
from custody import verification as verification_service
from custody.verification import VerificationUnavailableError
from db import repository as repo
from firebase.client import FirebaseUnavailableError
from storage.object_store import ObjectStoreUnavailableError, get_object_store
from utils.certificate import build_certificate_pdf
from utils.security import generate_evidence_id, sha256_bytes, sign_evidence_hash

router = APIRouter(prefix="/evidence", tags=["evidence"])


def _storage_path(case_id: str, evidence_id: str) -> str:
    return f"evidence/{case_id}/{evidence_id}/encrypted/original.bin"


async def _read_upload_within_limit(file: UploadFile) -> bytes:
    """Real, enforced upload size ceiling -- not just documentation. Reads
    in chunks and aborts as soon as the configured limit is exceeded,
    rather than buffering an arbitrarily large body into memory first."""
    settings = get_settings()
    limit = settings.max_upload_bytes
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=f"Upload exceeds the {limit} byte ({limit // (1024 * 1024)}MB) limit for evidence files.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/ingest")
async def ingest_evidence(
    case_id: str = Form(...),
    camera_id: str = Form(...),
    gps_lat: float | None = Form(None),
    gps_lon: float | None = Form(None),
    captured_at: str | None = Form(None),
    duration_seconds: float | None = Form(None),
    file: UploadFile = File(...),
    user: dict = Depends(require_roles("admin", "investigator")),
):
    """Real pipeline, in order: hash -> sign -> encrypt+store (local disk,
    backend/data/evidence/) -> Firestore metadata -> custody events ->
    Algorand anchor (best-effort) -> AI pipeline.

    Hashing/signing happen before anything else touches the file so their
    legal value covers the *original* bytes. Blockchain anchoring is
    attempted but never faked: on failure the evidence still exists with
    blockchain_status=UNAVAILABLE and can be retried via /anchor.
    """
    raw = await _read_upload_within_limit(file)
    file_hash = sha256_bytes(raw)
    evidence_id = generate_evidence_id()

    try:
        signature = sign_evidence_hash(file_hash)
    except RuntimeError:
        signature = None  # signing key not configured -- do not fake one

    now_iso = datetime.now(timezone.utc).isoformat()
    metadata = {
        "cameraId": camera_id,
        "gps": {"lat": gps_lat, "lon": gps_lon},
        "captureTimestamp": captured_at or now_iso,
        "caseId": case_id,
    }

    # Storage is attempted but never blocks the rest of the pipeline: hashing,
    # signing, custody, and blockchain anchoring are independently real and
    # verifiable even while Firebase Storage is unprovisioned. This mirrors
    # exactly how blockchain unavailability is already handled below -- an
    # honest storage_status field instead of a hard 503 that would make it
    # impossible to test/demo everything else. Nothing here is faked: if
    # upload fails, storage_status says so and storage_uri stays null.
    storage_path = _storage_path(case_id, evidence_id)
    storage_uri = None
    storage_status = "PENDING"
    storage_error = None
    try:
        store = get_object_store()
        storage_uri = store.put_encrypted(storage_path, raw)
        storage_status = "STORED"
    except ObjectStoreUnavailableError as exc:
        storage_status = "UNAVAILABLE"
        storage_error = str(exc)

    try:
        evidence = repo.create_evidence(
            evidence_id,
            case_id=case_id, camera_id=camera_id, file_name=file.filename, file_size=len(raw),
            mime_type=file.content_type, sha256=file_hash, signature=signature,
            storage_path=storage_path, storage_uri=storage_uri, storage_status=storage_status,
            storage_error=storage_error, metadata=metadata,
            submitted_by=user["id"], captured_at=captured_at,
        )
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    custody.append_event(evidence_id=evidence_id, event_type="EVIDENCE_CREATED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"])
    custody.append_event(evidence_id=evidence_id, event_type="HASH_GENERATED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"], metadata={"sha256": file_hash})
    if signature:
        custody.append_event(evidence_id=evidence_id, event_type="SIGNED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"])
    if storage_status == "STORED":
        custody.append_event(evidence_id=evidence_id, event_type="ENCRYPTED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"])
        custody.append_event(evidence_id=evidence_id, event_type="STORED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"], metadata={"storage_uri": storage_uri})
    else:
        custody.append_event(evidence_id=evidence_id, event_type="STORAGE_UNAVAILABLE", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"], metadata={"reason": storage_error})

    # The first recording chunk becomes segment 0 of the segment hash chain,
    # not just an opaque "original file" sitting outside it -- see
    # custody/verification.py's module docstring for why. No physical
    # storage duplication: this reuses the same storage_path/storage_status
    # already computed above, it just also records a chain entry for it.
    segment_zero = segment_chain.append_segment(
        evidence_id=evidence_id, sha256_hex=file_hash, duration_seconds=duration_seconds or 0.0,
        storage_status=storage_status, storage_path=storage_path if storage_status == "STORED" else None,
        storage_error=storage_error, file_size=len(raw), mime_type=file.content_type,
    )
    root_hash = verification_service.compute_root_hash(evidence_id, [segment_zero])
    repo.update_evidence(evidence_id, root_hash=root_hash)
    evidence["root_hash"] = root_hash
    custody.append_event(evidence_id=evidence_id, event_type="SEGMENT_CREATED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"],
                          metadata={"sequence": 0, "sha256": file_hash, "storage_status": storage_status})

    _anchor_root_hash_on_contract(evidence_id=evidence_id, root_hash=root_hash, case_id=case_id,
                                   camera_id=camera_id, evidence=evidence, user=user)

    _run_ai_pipeline(evidence_id, raw)

    return evidence


def _anchor_root_hash_on_contract(*, evidence_id: str, root_hash: str, case_id: str, camera_id: str,
                                   evidence: dict, user: dict) -> None:
    """Registers the Evidence Root Hash (not just the first chunk's hash) on
    the real CrimeLens Evidence Registry application -- see
    blockchain/algorand/contract.py. Mutates `evidence` in place with the
    real outcome; never fabricates a CONFIRMED status.

    blockchain_status values, all real:
        CONFIRMED      -- a real ApplicationCallTxn was confirmed on Testnet
        NOT_CONFIGURED -- ALGORAND_APP_ID is unset (contract never deployed)
        BLOCKED        -- the contract rejected this as a duplicate (a real
                          on-chain conflict -- should not normally happen
                          for a freshly generated evidence_id)
        UNAVAILABLE    -- network/funding/signing failure on an otherwise
                          configured, deployed contract
    """
    metadata_ref = f"{case_id}|{camera_id}"
    try:
        registration = contract_service.register_evidence_on_contract(
            evidence_id=evidence_id, root_hash=root_hash, metadata_ref=metadata_ref,
        )
        repo.update_evidence(
            evidence_id, blockchain_status="CONFIRMED", algorand_app_id=registration["app_id"],
            algorand_txid=registration["txid"], algorand_confirmed_round=registration["confirmed_round"],
            anchored_root_hash=root_hash,
        )
        evidence["blockchain_status"] = "CONFIRMED"
        evidence["algorand_app_id"] = registration["app_id"]
        evidence["algorand_txid"] = registration["txid"]
        evidence["anchored_root_hash"] = root_hash
        custody.append_event(evidence_id=evidence_id, event_type="BLOCKCHAIN_ANCHORED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"],
                              metadata={"app_id": registration["app_id"], "txid": registration["txid"],
                                        "confirmed_round": registration["confirmed_round"], "root_hash": root_hash})
    except ContractNotConfiguredError as exc:
        repo.update_evidence(evidence_id, blockchain_status="NOT_CONFIGURED")
        evidence["blockchain_status"] = "NOT_CONFIGURED"
        custody.append_event(evidence_id=evidence_id, event_type="BLOCKCHAIN_ANCHOR_SKIPPED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"], metadata={"reason": str(exc)})
    except EvidenceAlreadyRegisteredError as exc:
        repo.update_evidence(evidence_id, blockchain_status="BLOCKED")
        evidence["blockchain_status"] = "BLOCKED"
        custody.append_event(evidence_id=evidence_id, event_type="BLOCKCHAIN_ANCHOR_FAILED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"], metadata={"reason": str(exc)})
    except AlgorandUnavailableError as exc:
        repo.update_evidence(evidence_id, blockchain_status="UNAVAILABLE")
        evidence["blockchain_status"] = "UNAVAILABLE"
        custody.append_event(evidence_id=evidence_id, event_type="BLOCKCHAIN_ANCHOR_FAILED", actor_id=user["id"],
                              actor_name=user["name"], actor_role=user["role"], metadata={"reason": str(exc)})


def _run_ai_pipeline(evidence_id: str, raw: bytes):
    # Both classical-CV checks decode `raw` as a still image (cv2.imdecode).
    # That succeeds for photo evidence but not for video container bytes
    # (webm/mp4) -- a real, expected limitation, not a bug to hide. Each
    # check is isolated so one genuinely unsupported input never turns the
    # rest of ingestion (hashing/signing/storage/custody/anchoring, all
    # already complete by this point) into a failed request.
    try:
        tamper_result = run_tamper_checks(raw)
        repo.add_ai_result(evidence_id, "tamper", tamper_result, sha256_bytes(str(tamper_result).encode()))
    except Exception as exc:
        repo.add_ai_result(evidence_id, "tamper", {"error": str(exc)}, None)

    try:
        detection_result = detect_objects(raw)
        detection_result["weapon_check"] = flag_weapon_alerts(detection_result)
        repo.add_ai_result(evidence_id, "detection", detection_result, sha256_bytes(str(detection_result).encode()))
    except Exception as exc:
        repo.add_ai_result(evidence_id, "detection", {"error": str(exc)}, None)


@router.get("/{evidence_id}")
def get_evidence(evidence_id: str, _: dict = Depends(get_current_user)):
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    return {
        "evidence": evidence,
        "ai_results": repo.list_ai_results(evidence_id),
        "custody_chain": custody.verify_chain(evidence_id),
    }


@router.get("")
def list_evidence(case_id: str | None = None, _: dict = Depends(get_current_user)):
    return repo.list_evidence_for_case(case_id) if case_id else repo.list_all_evidence()


@router.post("/{evidence_id}/derive")
def create_derived_copy(evidence_id: str, user: dict = Depends(require_roles("admin", "investigator"))):
    """Creates a REAL derived copy: a brand-new evidence record with its own
    evidence_id and its own encrypted storage object (an actual byte-for-
    byte duplicate of the original, made now). Clearly marked
    is_derived=True / original_evidence_id=<original> everywhere it's
    displayed. The original's hash, root hash, segment chain, custody
    history, and blockchain proof are never read for writing and never
    modified -- this endpoint only reads the original's file once and
    writes exclusively new records (the original's own custody chain gets
    one new DERIVED_COPY_CREATED event appended, same as any other custody
    action, which does not alter its hash/signature/root hash).
    """
    original = repo.get_evidence(evidence_id)
    if original is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    try:
        store = get_object_store()
        raw = store.get_decrypted(original["storage_path"])
    except ObjectStoreUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    derived_id = generate_evidence_id()
    derived_hash = sha256_bytes(raw)
    storage_path = _storage_path(original["case_id"], derived_id)

    storage_status = "PENDING"
    storage_error = None
    storage_uri = None
    try:
        storage_uri = store.put_encrypted(storage_path, raw)
        storage_status = "STORED"
    except ObjectStoreUnavailableError as exc:
        storage_status = "UNAVAILABLE"
        storage_error = str(exc)

    derived = repo.create_evidence(
        derived_id,
        case_id=original["case_id"], camera_id=original["camera_id"], file_name=original.get("file_name"),
        file_size=len(raw), mime_type=original.get("mime_type"), sha256=derived_hash, signature=None,
        storage_path=storage_path, storage_uri=storage_uri, storage_status=storage_status,
        storage_error=storage_error, metadata=original.get("metadata"),
        submitted_by=user["id"], captured_at=original.get("captured_at"),
        is_derived=True, original_evidence_id=evidence_id,
        blockchain_status="NOT_APPLICABLE",  # derived copies are not independently anchored
    )

    custody.append_event(evidence_id=derived_id, event_type="EVIDENCE_CREATED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"],
                          metadata={"derived_from": evidence_id})
    custody.append_event(evidence_id=derived_id, event_type="DERIVED_FROM_ORIGINAL", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"],
                          metadata={"original_evidence_id": evidence_id, "original_sha256": original["sha256"]})
    # Recorded on the ORIGINAL's own custody trail too -- appending an event
    # does not alter the original's sha256/root_hash/signature.
    custody.append_event(evidence_id=evidence_id, event_type="DERIVED_COPY_CREATED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"],
                          metadata={"derived_evidence_id": derived_id})

    return derived


@router.post("/{evidence_id}/anchor")
def anchor_now(evidence_id: str, user: dict = Depends(require_roles("admin", "investigator"))):
    """Retries the Evidence Registry contract registration for evidence that
    ingested with blockchain_status other than CONFIRMED (e.g. the contract
    wasn't deployed, or the system account wasn't funded, yet). Anchors the
    CURRENT root hash (recomputed from all segments as of now, which may
    include segments appended after ingest), not a stale ingest-time value.
    """
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")
    if evidence.get("blockchain_status") == "CONFIRMED":
        raise HTTPException(status_code=400, detail="Already anchored")

    segments = segment_chain.list_segments(evidence_id)
    root_hash = verification_service.compute_root_hash(evidence_id, segments)
    if root_hash is None:
        raise HTTPException(status_code=400, detail="No segments recorded yet -- nothing to anchor")

    try:
        registration = contract_service.register_evidence_on_contract(
            evidence_id=evidence_id, root_hash=root_hash,
            metadata_ref=f"{evidence['case_id']}|{evidence['camera_id']}",
        )
    except ContractNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except EvidenceAlreadyRegisteredError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except AlgorandUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    repo.update_evidence(
        evidence_id, blockchain_status="CONFIRMED", algorand_app_id=registration["app_id"],
        algorand_txid=registration["txid"], algorand_confirmed_round=registration["confirmed_round"],
        anchored_root_hash=root_hash,
    )
    custody.append_event(evidence_id=evidence_id, event_type="BLOCKCHAIN_ANCHORED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"],
                          metadata={"app_id": registration["app_id"], "txid": registration["txid"],
                                    "confirmed_round": registration["confirmed_round"], "root_hash": root_hash})
    return registration


@router.get("/{evidence_id}/verify")
def verify_evidence(evidence_id: str):
    """Public, no-auth deterministic verification -- see
    custody/verification.py for the full algorithm: recomputes the root
    file's hash, verifies the Ed25519 signature, verifies the custody
    chain, verifies the segment hash chain (sequence continuity + prev-hash
    linkage + recomputed segment hashes), recomputes the Evidence Root Hash
    and compares it to the last-stored value, and independently re-checks
    the Algorand anchor. AUTHENTIC only if every cryptographic-integrity
    check passes; blockchain anchor status is reported separately and never
    turns real integrity into a false TAMPERED verdict."""
    try:
        result = verification_service.verify_evidence(evidence_id)
    except VerificationUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="Evidence not found")
    return result


def _segment_storage_path(case_id: str, evidence_id: str, sequence: int) -> str:
    return f"evidence/{case_id}/{evidence_id}/segments/{sequence:06d}.webm"


@router.post("/{evidence_id}/segments")
async def append_segment(
    evidence_id: str, duration_seconds: float = Form(...), file: UploadFile = File(...),
    user: dict = Depends(require_roles("admin", "investigator")),
):
    """Appends one recording segment to the evidence's hash chain. Called by
    the frontend recorder on every MediaRecorder `ondataavailable` chunk, so
    hashing happens incrementally during recording rather than waiting for
    Stop -- per the segmentation requirement. Segment write to local disk is
    attempted but, exactly like the main file, never blocks hash-chain
    creation: storage_status honestly reflects whether the bytes actually
    made it to backend/data/evidence/."""
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    raw = await _read_upload_within_limit(file)
    segment_hash = sha256_bytes(raw)
    existing = segment_chain.list_segments(evidence_id)
    sequence = len(existing)
    storage_path = _segment_storage_path(evidence["case_id"], evidence_id, sequence)

    storage_status = "PENDING"
    storage_error = None
    try:
        store = get_object_store()
        store.put_encrypted(storage_path, raw)
        storage_status = "STORED"
    except ObjectStoreUnavailableError as exc:
        storage_status = "UNAVAILABLE"
        storage_error = str(exc)
        storage_path = None

    segment = segment_chain.append_segment(
        evidence_id=evidence_id, sha256_hex=segment_hash, duration_seconds=duration_seconds,
        storage_status=storage_status, storage_path=storage_path, storage_error=storage_error,
        file_size=len(raw), mime_type=file.content_type,
    )

    # Evidence Root Hash covers the ENTIRE segment chain, so it must be
    # recomputed from all segments (not just this one) every time a new
    # segment is appended -- see custody/verification.py.
    all_segments = existing + [segment]
    root_hash = verification_service.compute_root_hash(evidence_id, all_segments)
    repo.update_evidence(evidence_id, root_hash=root_hash)

    custody.append_event(
        evidence_id=evidence_id, event_type="SEGMENT_CREATED", actor_id=user["id"],
        actor_name=user["name"], actor_role=user["role"],
        metadata={"sequence": sequence, "sha256": segment_hash, "storage_status": storage_status},
    )
    return segment


@router.get("/{evidence_id}/segments")
def list_segments(evidence_id: str, _: dict = Depends(get_current_user)):
    return {"segments": segment_chain.list_segments(evidence_id), "chain": segment_chain.verify_segment_chain(evidence_id)}


USER_TRIGGERABLE_CUSTODY_ACTIONS = {"ACCESSED", "EXPORTED", "TRANSFERRED", "ANALYZED"}


class CustodyRequest(BaseModel):
    action: str  # ACCESSED | EXPORTED | TRANSFERRED | ANALYZED
    note: str = ""


@router.post("/{evidence_id}/custody")
def log_custody(evidence_id: str, payload: CustodyRequest, user: dict = Depends(require_roles("admin", "investigator"))):
    """Manually logs a custody action. Restricted to admin/investigator --
    viewers are read-only and must not be able to write to the legal
    chain-of-custody record. `action` is restricted to the genuine
    user-triggerable set: system-generated event types (EVIDENCE_CREATED,
    HASH_GENERATED, SEGMENT_CREATED, BLOCKCHAIN_ANCHORED,
    VERIFICATION_REQUESTED, etc.) can only ever be appended by the backend
    itself elsewhere in this file -- allowing a client to supply them here
    would let anyone forge what looks like a system-generated custody
    entry."""
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")
    if payload.action not in USER_TRIGGERABLE_CUSTODY_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"action must be one of {sorted(USER_TRIGGERABLE_CUSTODY_ACTIONS)} -- "
                   f"system-generated custody events cannot be logged manually.",
        )

    event = custody.append_event(
        evidence_id=evidence_id, event_type=payload.action, actor_id=user["id"],
        actor_name=user["name"], actor_role=user["role"],
        metadata={"note": payload.note} if payload.note else None,
    )
    return event


@router.get("/{evidence_id}/custody")
def get_custody(evidence_id: str):
    return {"events": custody.list_events(evidence_id), "chain": custody.verify_chain(evidence_id)}


@router.get("/{evidence_id}/blockchain")
def get_blockchain_status(evidence_id: str):
    """Real, independent blockchain proof status -- reads the actual
    on-chain Evidence Registry box (or, for legacy evidence, the actual
    transaction note) fresh on every call, never just echoing the cached
    Firestore field. See custody/verification.py::_read_blockchain_state.
    """
    try:
        result = verification_service.verify_evidence(evidence_id, record_access=False)
    except VerificationUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    return {
        "evidence_id": evidence_id,
        "root_hash": result["root_hash"] or "UNAVAILABLE",
        "blockchain_status": result["blockchain_status"],
        "network": result["network"],
        "application_id": result["application_id"],
        "transaction_id": result["transaction_id"],
        "anchored_root_hash": result["anchored_root_hash"],
        "anchor_timestamp": result["anchor_timestamp"],
        "verification_status": result["verification_status"],
        "detail": result["blockchain"],
    }


@router.get("/{evidence_id}/file")
def get_evidence_file(evidence_id: str, user: dict = Depends(get_current_user)):
    """Streams the actual decrypted evidence bytes for in-app playback.
    Real 503 if the file was never stored (Storage unavailable at ingest
    time) -- never a silently empty or fake response."""
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")
    if evidence.get("storage_status") != "STORED":
        raise HTTPException(status_code=503, detail=f"File not available: storage_status={evidence.get('storage_status')}")

    store = get_object_store()
    raw = store.get_decrypted(evidence["storage_path"])
    custody.append_event(evidence_id=evidence_id, event_type="ACCESSED", actor_id=user["id"],
                          actor_name=user["name"], actor_role=user["role"])
    return Response(content=raw, media_type=evidence.get("mime_type") or "application/octet-stream")


@router.post("/{evidence_id}/verify-copy")
async def verify_test_copy(evidence_id: str, file: UploadFile = File(...)):
    """Real, controlled tamper-detection demo: upload any file (e.g. the
    original recording with one byte flipped) and this recomputes its ACTUAL
    SHA-256 and compares it against the registered hash -- genuine crypto,
    not a client-side fabricated result. Never touches the original
    evidence: it only ever reads the uploaded bytes.
    """
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    raw = await _read_upload_within_limit(file)
    test_hash = sha256_bytes(raw)
    hash_match = test_hash == evidence["sha256"]

    return {
        "evidence_id": evidence_id,
        "registered_hash": evidence["sha256"],
        "test_copy_hash": test_hash,
        "hash_match": hash_match,
        "verdict": "AUTHENTIC" if hash_match else "TAMPERED",
        "reason": None if hash_match else "The uploaded file's SHA-256 does not match the hash registered at ingest -- the bytes have changed.",
    }


class ChainTestRequest(BaseModel):
    exclude_sequences: list[int] = []
    reorder: bool = False
    corrupt_sequences: list[int] = []


@router.post("/{evidence_id}/verify-chain-test")
def verify_chain_test(evidence_id: str, payload: ChainTestRequest):
    """Real, controlled test of the segment hash-chain algorithm: pulls this
    evidence's ACTUAL stored segments, applies the requested transformation
    to an IN-MEMORY COPY only, then runs the exact same
    `segment_chain.verify_segments()` pure function production verification
    uses. Nothing is written back to Firestore -- this proves the algorithm
    actually detects missing/reordered/modified segments without ever
    touching the real stored chain.

    `exclude_sequences` drops specific sequence numbers to simulate a
    missing segment (caught by the sequence-continuity check).
    `reorder` corrupts segment 1's `prev_segment_hash` so it no longer
    points at segment 0's real hash, isolating the prev-hash-linkage check
    specifically -- a full positional swap would trip the sequence-
    continuity check first instead (sequence numbers travel with the
    swapped dicts), which demonstrates a different, already-covered failure
    mode rather than the "chain link broken" case this flag is for.
    `corrupt_sequences` flips the recorded `sha256` of specific sequence
    numbers without recomputing `segment_hash` to match, so
    verify_segments() recomputes a different hash than what's stored --
    isolating the segment-content-tamper check (segment_hash_mismatch).
    """
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    segments = segment_chain.list_segments(evidence_id)
    test_segments = [dict(s) for s in segments if s["sequence"] not in payload.exclude_sequences]
    if payload.reorder and len(test_segments) >= 2:
        test_segments[1]["prev_segment_hash"] = "1" * 64  # deliberately wrong link
    for seg in test_segments:
        if seg["sequence"] in payload.corrupt_sequences:
            seg["sha256"] = sha256_bytes(seg["sha256"].encode() + b"tampered")  # real SHA-256, deliberately wrong content

    result = segment_chain.verify_segments(test_segments)
    failure_reason = None
    if not result["intact"]:
        broken = result.get("broken_at") or {}
        failure_reason = verification_service.FAILURE_REASON_MAP.get(broken.get("reason"), "SEGMENT_CHAIN_BROKEN")

    return {
        "evidence_id": evidence_id,
        "original_segment_count": len(segments),
        "test_segment_count": len(test_segments),
        "excluded_sequences": payload.exclude_sequences,
        "reordered": payload.reorder,
        "chain": result,
        "verdict": "AUTHENTIC" if result["intact"] else "INTEGRITY_FAILURE",
        "failure_reason": failure_reason,
        "failed_segment": (result.get("broken_at") or {}).get("sequence"),
    }


@router.get("/{evidence_id}/verify-url")
def get_verify_url(evidence_id: str):
    settings = get_settings()
    return {"url": f"{settings.frontend_base_url}/verify/{evidence_id}"}


@router.get("/{evidence_id}/qr")
def get_qr_code(evidence_id: str):
    """QR encodes only the public verification URL -- no private evidence
    data. Points at the real /verify/{id} route, which runs the actual
    deterministic verification, never a static 'Verified' page."""
    evidence = repo.get_evidence(evidence_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    settings = get_settings()
    url = f"{settings.frontend_base_url}/verify/{evidence_id}"
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@router.get("/{evidence_id}/certificate")
def get_certificate(evidence_id: str):
    try:
        result = verification_service.verify_evidence(evidence_id, record_access=False)
    except VerificationUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    evidence = repo.get_evidence(evidence_id)
    events = custody.list_events(evidence_id)
    segments = segment_chain.list_segments(evidence_id)
    total_duration = sum(s.get("duration_seconds") or 0 for s in segments) if segments else None

    owner_name = "UNAVAILABLE"
    submitted_by = evidence.get("submitted_by")
    if submitted_by:
        owner = repo.get_user(submitted_by)
        if owner:
            owner_name = owner.get("name") or owner.get("email") or "UNAVAILABLE"

    pdf_bytes = build_certificate_pdf(
        evidence_id=evidence_id,
        case_id=evidence["case_id"],
        camera_id=evidence.get("camera_id") or "UNAVAILABLE",
        owner_name=owner_name,
        captured_at=evidence.get("captured_at") or evidence.get("ingested_at") or "UNAVAILABLE",
        duration_seconds=total_duration,
        segment_count=result["segment_count"],
        original_hash=result["original_hash"],
        current_hash=result["current_hash"],
        root_hash=result["root_hash"],
        matches=result["hash_match"],
        chain_tx_hash=result["blockchain_txid"],
        blockchain_status=result["blockchain_status"],
        custody_intact=result["custody_chain_intact"],
        segment_chain_intact=result["segment_chain_intact"],
        verdict=result["verdict"],
        custody_events=[{"action": e["event_type"], "actor": e.get("actor_name") or "system",
                          "timestamp": str(e["occurred_at"])} for e in events],
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=certificate-{evidence_id}.pdf"},
    )
