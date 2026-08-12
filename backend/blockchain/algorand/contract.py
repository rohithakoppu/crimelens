"""Real backend integration for the CrimeLens Evidence Registry application
(see `contracts/evidence_registry.py` for the on-chain logic + state
schema).

Both functions here talk to the real Algorand network via `algosdk` --
there is no simulated/offline path that fabricates a result. If the
application isn't deployed yet (`ALGORAND_APP_ID` unset) or the system
account can't cover a real transaction, every public function raises
`AlgorandUnavailableError`/`EvidenceAlreadyRegisteredError` with the real
underlying reason -- callers turn that into an honest
NOT_CONFIGURED/UNAVAILABLE/BLOCKED status, never a fake CONFIRMED one.
"""
import base64
import hashlib
from functools import lru_cache

from algosdk import encoding
from algosdk.error import AlgodHTTPError
from algosdk.transaction import ApplicationCallTxn, OnComplete, PaymentTxn, assign_group_id, wait_for_confirmation

from blockchain.algorand.client import AlgorandUnavailableError, get_algorand_client
from config import get_settings

METHOD_REGISTER_EVIDENCE = b"register_evidence"
ROOT_HASH_LEN = 32
METADATA_HASH_LEN = 32
ADDRESS_LEN = 32
TIMESTAMP_LEN = 8
BOX_VALUE_LEN = ROOT_HASH_LEN + TIMESTAMP_LEN + ADDRESS_LEN + METADATA_HASH_LEN


class EvidenceAlreadyRegisteredError(RuntimeError):
    """Raised when the contract genuinely rejects a duplicate registration
    (the box for this evidence_id already exists) -- the on-chain record is
    immutable, so this is a real conflict, not a bug to retry past."""


class ContractNotConfiguredError(AlgorandUnavailableError):
    """Raised when ALGORAND_APP_ID is unset -- the contract has never been
    deployed, distinct from a deployed-but-currently-unreachable contract."""


def _require_app_id() -> int:
    settings = get_settings()
    if not settings.algorand_app_id.strip():
        raise ContractNotConfiguredError(
            "ALGORAND_APP_ID is not configured -- the Evidence Registry application has not been "
            "deployed yet (see scripts/deploy_contract.py). Falling back to no on-chain proof."
        )
    try:
        return int(settings.algorand_app_id.strip())
    except ValueError:
        raise ContractNotConfiguredError(f"ALGORAND_APP_ID={settings.algorand_app_id!r} is not a valid integer.")


def _box_mbr_microalgos(box_name: bytes, box_value_len: int) -> int:
    """Algorand box minimum-balance requirement: 2500 base + 400 per byte
    of (key + value). The application account must hold this before the
    box can be created -- paid here via a grouped Payment transaction from
    the same system account that signs the app call."""
    return 2_500 + 400 * (len(box_name) + box_value_len)


@lru_cache
def _app_address(app_id: int) -> str:
    from algosdk.logic import get_application_address

    return get_application_address(app_id)


def register_evidence_on_contract(evidence_id: str, root_hash: str, metadata_ref: str | None = None) -> dict:
    """Submits a REAL, atomic 2-transaction group to Algorand Testnet:
    [1] a Payment funding the box's minimum-balance requirement, [2] the
    ApplicationCallTxn that writes the box. Both are signed by the system
    account and submitted together, so the box-funding payment can never
    succeed without the registration also succeeding (or vice versa).

    Raises:
        ContractNotConfiguredError  -- no ALGORAND_APP_ID set
        AlgorandUnavailableError    -- network/funding/signing failure
        EvidenceAlreadyRegisteredError -- the contract rejected this as a
            duplicate (box already exists) -- a REAL on-chain conflict, not
            a transient error
    """
    # Input validation runs unconditionally, before any config/network check
    # -- a malformed evidence_id/root_hash is a caller bug regardless of
    # whether the contract happens to be deployed yet.
    if not evidence_id:
        raise ValueError("evidence_id must not be empty")
    try:
        root_hash_bytes = bytes.fromhex(root_hash)
    except ValueError:
        raise ValueError(f"root_hash must be hex-encoded, got {root_hash!r}")
    if len(root_hash_bytes) != ROOT_HASH_LEN:
        raise ValueError(f"root_hash must be exactly {ROOT_HASH_LEN} bytes, got {len(root_hash_bytes)}")

    app_id = _require_app_id()
    chain = get_algorand_client()
    chain._require_ready()  # reuses the existing "system account configured" check

    evidence_id_bytes = evidence_id.encode("utf-8")
    metadata_hash_bytes = hashlib.sha256((metadata_ref or "").encode("utf-8")).digest()

    box_value_len = BOX_VALUE_LEN
    box_mbr = _box_mbr_microalgos(evidence_id_bytes, box_value_len)
    app_address = _app_address(app_id)

    try:
        params = chain.algod.suggested_params()

        # `box_mbr` alone is only the box's own incremental minimum-balance
        # requirement. Every Algorand account -- including this app's own
        # escrow account -- separately needs the network's baseline minimum
        # balance (100,000 microAlgos) before it can hold anything at all.
        # For the app's first-ever box that baseline hasn't been funded yet,
        # so paying just box_mbr leaves the account under its required
        # minimum and the whole atomic group is rejected by the transaction
        # pool. Querying the account's real current balance/min-balance and
        # paying exactly the shortfall handles both the first registration
        # (pays the full 100,000 + box_mbr) and every later one (the account
        # already clears its baseline, so only the new box's increment is
        # paid) -- never a guessed or hardcoded top-up amount.
        try:
            app_account_info = chain.algod.account_info(app_address)
            app_current_balance = app_account_info.get("amount", 0)
            app_current_min_balance = app_account_info.get("min-balance", 0)
        except AlgodHTTPError:
            app_current_balance = 0
            app_current_min_balance = 0
        required_after_box = app_current_min_balance + box_mbr
        fund_amount = max(0, required_after_box - app_current_balance)

        fund_txn = PaymentTxn(sender=chain.address, sp=params, receiver=app_address, amt=fund_amount)
        app_txn = ApplicationCallTxn(
            sender=chain.address,
            sp=params,
            index=app_id,
            on_complete=OnComplete.NoOpOC,
            app_args=[METHOD_REGISTER_EVIDENCE, evidence_id_bytes, root_hash_bytes, metadata_hash_bytes],
            boxes=[(0, evidence_id_bytes)],  # index 0 = "this app" per ARC-22
        )

        assign_group_id([fund_txn, app_txn])
        signed_fund = fund_txn.sign(chain._private_key)
        signed_app = app_txn.sign(chain._private_key)

        txid = chain.algod.send_transactions([signed_fund, signed_app])
        confirmed = wait_for_confirmation(chain.algod, txid, 8)
    except AlgodHTTPError as exc:
        message = str(exc)
        if "assert failed" in message.lower() or "logic eval error" in message.lower():
            raise EvidenceAlreadyRegisteredError(
                f"Evidence {evidence_id} is already registered on-chain (app {app_id}) -- "
                f"the contract rejected this as a duplicate. Original: {exc}"
            )
        raise AlgorandUnavailableError(f"Evidence Registry registration failed: {exc}")
    except Exception as exc:
        raise AlgorandUnavailableError(f"Evidence Registry registration failed: {exc}")

    return {
        "app_id": app_id,
        "txid": txid,
        "confirmed_round": confirmed.get("confirmed-round"),
        "root_hash": root_hash,
        "box_name": evidence_id,
        "registrant": chain.address,
    }


def get_evidence_from_contract(evidence_id: str) -> dict | None:
    """Reads the box directly via algod's public box API -- a free read,
    no transaction, no fee, independent of Firestore. Returns None if no
    box exists for this evidence_id (never registered, or a different
    application ID than the one currently configured)."""
    app_id = _require_app_id()
    chain = get_algorand_client()
    evidence_id_bytes = evidence_id.encode("utf-8")

    try:
        box = chain.algod.application_box_by_name(app_id, evidence_id_bytes)
    except AlgodHTTPError as exc:
        if "box not found" in str(exc).lower() or getattr(exc, "code", None) == 404:
            return None
        raise AlgorandUnavailableError(f"Evidence Registry box lookup failed: {exc}")
    except Exception as exc:
        raise AlgorandUnavailableError(f"Evidence Registry box lookup failed: {exc}")

    value = base64.b64decode(box["value"])
    if len(value) != BOX_VALUE_LEN:
        raise AlgorandUnavailableError(
            f"Evidence Registry box for {evidence_id} has unexpected length {len(value)} "
            f"(expected {BOX_VALUE_LEN}) -- refusing to parse a malformed on-chain record."
        )

    root_hash_bytes = value[0:32]
    registered_at = int.from_bytes(value[32:40], "big")
    registrant_bytes = value[40:72]
    metadata_hash_bytes = value[72:104]

    return {
        "app_id": app_id,
        "evidence_id": evidence_id,
        "root_hash": root_hash_bytes.hex(),
        "registered_at": registered_at,
        "registrant": encoding.encode_address(registrant_bytes),
        "metadata_hash": metadata_hash_bytes.hex(),
    }
