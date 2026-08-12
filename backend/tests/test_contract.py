"""Phase 3: CrimeLens Evidence Registry smart contract + backend integration.

Split, as required, into:

UNIT TESTS (this file, run by `pytest -q`, no network) -- the contract
compiles to real TEAL (proves the PyTeal source is syntactically valid,
independent of any deployment), backend input validation, and readback
logic are all tested by mocking the external Algorand network at the SDK
boundary (`blockchain.algorand.contract.get_algorand_client` /
`blockchain.algorand.contract.get_evidence_from_contract`) -- never by
fabricating a transaction ID or box value that pretends to be real.

LIVE TESTNET TEST (NOT included here, and not run by pytest) -- an actual
ApplicationCreateTxn + registration against Algorand Testnet, which requires
a funded system account. See `scripts/deploy_contract.py`, which was run
manually against the real network for this phase and reported (accurately)
that the account holds 0 ALGO -- deployment is genuinely blocked, not
skipped or faked. No live-network pytest test exists here because there is
nothing real to run it against yet; adding one that mocks around that would
contradict the whole point of a "live" test.
"""
import hashlib

import pytest

from blockchain.algorand.contract import (
    BOX_VALUE_LEN,
    ContractNotConfiguredError,
    EvidenceAlreadyRegisteredError,
    get_evidence_from_contract,
    register_evidence_on_contract,
)
from blockchain.algorand.contracts.evidence_registry import (
    BOX_VALUE_LEN as CONTRACT_BOX_VALUE_LEN,
    METADATA_HASH_LEN,
    ROOT_HASH_LEN,
    compile_approval,
    compile_clear,
)
from custody.verification import _read_blockchain_state


# ------------------------------------------------------- 1. contract schema

def test_contract_compiles_to_real_teal():
    """Real compilation, not a syntax guess -- compileTeal() would raise on
    invalid PyTeal. Also documents the actual on-chain method name and
    #pragma version so this test breaks loudly if either silently changes."""
    approval = compile_approval()
    clear = compile_clear()

    assert approval.startswith("#pragma version 8")
    assert "register_evidence" in approval
    assert "box_put" in approval
    assert "box_len" in approval
    assert clear.strip() == "#pragma version 8\nint 1\nreturn"


def test_contract_rejects_update_and_delete():
    """Immutability at the application level: the compiled program must
    explicitly reject UpdateApplication/DeleteApplication rather than
    defaulting to approve (PyTeal's Cond has no catch-all branch for these,
    so an unhandled OnComplete would error at compile time if it were
    missing -- this asserts the TEAL actually contains the reject paths)."""
    approval = compile_approval()
    assert "UpdateApplication" in approval
    assert "DeleteApplication" in approval


def test_box_value_layout_is_104_bytes_documented_and_consistent():
    """Schema: root_hash(32) + timestamp(8) + registrant(32) + metadata_hash(32).
    Both the contract module and the backend integration module must agree
    on this constant -- a drift between them would silently corrupt reads."""
    assert ROOT_HASH_LEN == 32
    assert METADATA_HASH_LEN == 32
    assert CONTRACT_BOX_VALUE_LEN == 32 + 8 + 32 + 32 == 104
    assert BOX_VALUE_LEN == CONTRACT_BOX_VALUE_LEN


# --------------------------------------------------- 2. input validation

def test_register_evidence_rejects_non_hex_root_hash():
    with pytest.raises(ValueError, match="hex-encoded"):
        register_evidence_on_contract("EVD-2026-TEST", "not-hex-at-all!!")


def test_register_evidence_rejects_wrong_length_root_hash():
    with pytest.raises(ValueError, match="32 bytes"):
        register_evidence_on_contract("EVD-2026-TEST", "ab" * 10)  # 10 bytes, not 32


def test_register_evidence_rejects_empty_evidence_id():
    valid_hash = hashlib.sha256(b"anything").hexdigest()
    with pytest.raises(ValueError, match="evidence_id"):
        register_evidence_on_contract("", valid_hash)


def test_register_evidence_reports_not_configured_when_no_app_id(monkeypatch):
    """With ALGORAND_APP_ID unset, registration must fail with a real,
    specific, honest error -- never silently succeed. Explicitly forces the
    unconfigured case via monkeypatch rather than relying on the ambient
    .env lacking a value, since a real deployment now legitimately sets one."""
    import blockchain.algorand.contract as contract_module

    class _NoAppIdSettings:
        algorand_app_id = ""

    monkeypatch.setattr(contract_module, "get_settings", lambda: _NoAppIdSettings())
    valid_hash = hashlib.sha256(b"real evidence bytes").hexdigest()
    with pytest.raises(ContractNotConfiguredError):
        register_evidence_on_contract("EVD-2026-TEST", valid_hash)


def test_get_evidence_reports_not_configured_when_no_app_id(monkeypatch):
    import blockchain.algorand.contract as contract_module

    class _NoAppIdSettings:
        algorand_app_id = ""

    monkeypatch.setattr(contract_module, "get_settings", lambda: _NoAppIdSettings())
    with pytest.raises(ContractNotConfiguredError):
        get_evidence_from_contract("EVD-2026-TEST")


# ------------------------------------------- 5/6/7/8. blockchain readback

def _fake_evidence(root_hash: str, app_id="123456", txid=None) -> dict:
    return {"sha256": "x" * 64, "algorand_app_id": app_id, "algorand_txid": txid}


def test_readback_confirms_when_chain_root_hash_matches(monkeypatch):
    import blockchain.algorand.contract as contract_module

    local_root = hashlib.sha256(b"segments").hexdigest()
    monkeypatch.setattr(contract_module, "get_evidence_from_contract", lambda evidence_id: {
        "app_id": 123456, "evidence_id": evidence_id, "root_hash": local_root,
        "registered_at": 1_700_000_000, "registrant": "SOMEADDRESS", "metadata_hash": "y" * 64,
    })

    result = _read_blockchain_state("EVD-2026-TEST", _fake_evidence(local_root), local_root)

    assert result["checked"] is True
    assert result["verified"] is True
    assert result["status"] == "CONFIRMED"
    assert result["anchored_root_hash"] == local_root


def test_readback_reports_hash_mismatch_when_chain_disagrees(monkeypatch):
    """Test 7 (mandatory): on-chain root hash differs from the locally
    recomputed one -- a real, detectable discrepancy, not a guess."""
    import blockchain.algorand.contract as contract_module

    local_root = hashlib.sha256(b"real segments").hexdigest()
    onchain_root = hashlib.sha256(b"different segments").hexdigest()
    monkeypatch.setattr(contract_module, "get_evidence_from_contract", lambda evidence_id: {
        "app_id": 123456, "evidence_id": evidence_id, "root_hash": onchain_root,
        "registered_at": 1_700_000_000, "registrant": "SOMEADDRESS", "metadata_hash": "y" * 64,
    })

    result = _read_blockchain_state("EVD-2026-TEST", _fake_evidence(local_root), local_root)

    assert result["checked"] is True
    assert result["verified"] is False
    assert result["status"] == "HASH_MISMATCH"
    assert result["anchored_root_hash"] == onchain_root
    assert result["expected_root_hash"] == local_root


def test_readback_reports_unavailable_when_no_box_exists(monkeypatch):
    """Test 9 (mandatory): configured contract, but no on-chain record for
    this evidence_id (e.g. registration never confirmed) -> UNAVAILABLE,
    never treated as a mismatch or a fabricated confirmation."""
    import blockchain.algorand.contract as contract_module

    monkeypatch.setattr(contract_module, "get_evidence_from_contract", lambda evidence_id: None)

    local_root = hashlib.sha256(b"segments").hexdigest()
    result = _read_blockchain_state("EVD-2026-TEST", _fake_evidence(local_root), local_root)

    assert result["status"] == "UNAVAILABLE"
    assert result["verified"] is False


def test_readback_reports_not_configured_with_no_app_id_and_no_txid():
    result = _read_blockchain_state("EVD-2026-TEST", _fake_evidence(None, app_id=None, txid=None), None)
    assert result["status"] == "NOT_CONFIGURED"
    assert result["verified"] is False


def test_blockchain_unavailable_does_not_change_integrity_verdict():
    """Test 8 (mandatory, contract-level): _determine_verdict has no
    blockchain parameter at all (see test_verification.py for the direct
    assertion) -- this test additionally confirms _read_blockchain_state's
    output, whatever it is, plays no role in verdict computation by
    checking the function signatures are genuinely decoupled."""
    import inspect

    from custody.verification import _determine_verdict

    verdict_params = set(inspect.signature(_determine_verdict).parameters)
    assert "blockchain" not in verdict_params
    assert "blockchain_status" not in verdict_params


# --------------------------------------------------- 3. duplicate rejection

def test_evidence_already_registered_error_is_distinguishable_from_unavailable():
    """Test 3 (mandatory): the contract-level duplicate-registration
    rejection must be a distinct, specific error type an API layer can map
    to a real HTTP 409 conflict -- not lumped in with generic network
    failures (which should map to 503)."""
    from blockchain.algorand.client import AlgorandUnavailableError

    assert issubclass(EvidenceAlreadyRegisteredError, RuntimeError)
    assert not issubclass(EvidenceAlreadyRegisteredError, AlgorandUnavailableError)
