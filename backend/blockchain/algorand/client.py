"""Real Algorand Testnet anchoring.

Design (per spec Sec 2): evidence integrity is anchored as the `note` field
of a minimal, real, 0-ALGO self-payment transaction -- not a custom smart
contract, since a note is sufficient for the MVP and keeps everything except
metadata off-chain. The system account (SYSTEM_ALGORAND_MNEMONIC) signs and
pays the ~0.001 ALGO fee for every anchor; individual users never sign
on-chain transactions themselves and no private key ever reaches the
frontend.

If the system account isn't configured or the network is unreachable, every
public method raises AlgorandUnavailableError -- callers must catch this and
surface "BLOCKCHAIN ANCHOR PENDING / UNAVAILABLE", never a fabricated
confirmation.
"""
import base64
import json
from functools import lru_cache

from algosdk import account, mnemonic
from algosdk.error import AlgodHTTPError, IndexerHTTPError
from algosdk.transaction import PaymentTxn, wait_for_confirmation
from algosdk.v2client import algod, indexer

from config import get_settings

NOTE_SCHEMA_VERSION = "1.0"
NOTE_TYPE = "EVIDENCE_ANCHOR"


class AlgorandUnavailableError(RuntimeError):
    """Raised whenever a real anchor/verify cannot be performed right now."""


class AlgorandClient:
    def __init__(self):
        s = get_settings()
        self.settings = s
        self.network = s.algorand_network
        self.explorer_base = s.algorand_explorer_base

        self.algod = algod.AlgodClient(
            s.algorand_algod_token, s.algorand_algod_server, headers=self._headers(s.algorand_algod_token)
        )
        self.indexer = indexer.IndexerClient(
            s.algorand_indexer_token, s.algorand_indexer_server, headers=self._headers(s.algorand_indexer_token)
        )

        self.address = None
        self._private_key = None
        if s.system_algorand_mnemonic.strip():
            try:
                self._private_key = mnemonic.to_private_key(s.system_algorand_mnemonic.strip())
                self.address = account.address_from_private_key(self._private_key)
            except Exception as exc:  # bad mnemonic -- fail closed, not silently
                raise AlgorandUnavailableError(f"Invalid SYSTEM_ALGORAND_MNEMONIC: {exc}")

    @staticmethod
    def _headers(token: str):
        # AlgoNode's public endpoints take no token; a non-empty token needs
        # to travel as X-API-Key rather than algod's default header.
        return {"X-API-Key": token} if token else {}

    def is_configured(self) -> bool:
        return self._private_key is not None

    def status(self) -> dict:
        """Never raises -- used for the system-health screen."""
        out = {
            "configured": self.is_configured(),
            "network": self.network,
            "address": self.address,
            "connected": False,
            "balance_microalgos": None,
            "error": None,
        }
        if not self.is_configured():
            out["error"] = "SYSTEM_ALGORAND_MNEMONIC not set"
            return out
        try:
            info = self.algod.account_info(self.address)
            out["connected"] = True
            out["balance_microalgos"] = info.get("amount")
        except Exception as exc:
            out["error"] = str(exc)
        return out

    def _require_ready(self):
        if not self.is_configured():
            raise AlgorandUnavailableError(
                "Algorand system account not configured (SYSTEM_ALGORAND_MNEMONIC missing)."
            )

    def build_note(self, *, evidence_id: str, sha256_hex: str, camera_id: str, case_id: str,
                    evidence_type: str = "video", custody_ref: str | None = None) -> dict:
        return {
            "type": NOTE_TYPE,
            "version": NOTE_SCHEMA_VERSION,
            "evidence_id": evidence_id,
            "sha256": sha256_hex,
            "case_id": case_id,
            "camera_id": camera_id,
            "evidence_type": evidence_type,
            "custody_ref": custody_ref,
        }

    def anchor_evidence(self, *, evidence_id: str, sha256_hex: str, camera_id: str, case_id: str,
                         evidence_type: str = "video", custody_ref: str | None = None,
                         wait_rounds: int = 8) -> dict:
        """Submits a real Testnet transaction and waits for confirmation.

        Raises AlgorandUnavailableError on any failure -- there is no
        fallback path that fabricates a txid.
        """
        self._require_ready()
        note_obj = self.build_note(
            evidence_id=evidence_id, sha256_hex=sha256_hex, camera_id=camera_id,
            case_id=case_id, evidence_type=evidence_type, custody_ref=custody_ref,
        )
        note_bytes = json.dumps(note_obj, separators=(",", ":")).encode("utf-8")
        if len(note_bytes) > 1024:
            raise ValueError("Algorand transaction note must be <= 1024 bytes")

        try:
            params = self.algod.suggested_params()
            txn = PaymentTxn(
                sender=self.address,
                sp=params,
                receiver=self.address,  # self-payment: only the note carries meaning
                amt=0,
                note=note_bytes,
            )
            signed = txn.sign(self._private_key)
            txid = self.algod.send_transaction(signed)
            confirmed = wait_for_confirmation(self.algod, txid, wait_rounds)
        except (AlgodHTTPError, Exception) as exc:
            raise AlgorandUnavailableError(f"Algorand anchor submission failed: {exc}")

        return {
            "txid": txid,
            "confirmed_round": confirmed.get("confirmed-round"),
            "note": note_obj,
            "explorer_url": self.explorer_url(txid),
        }

    def explorer_url(self, txid: str) -> str:
        return f"{self.explorer_base}/{txid}"

    def get_transaction(self, txid: str) -> dict:
        """Independent lookup: retrieves the real on-chain transaction and
        decodes its note. Tries the Indexer first (canonical, post-confirm),
        falls back to algod's pending-pool lookup for just-submitted txns
        the Indexer hasn't caught up to yet."""
        try:
            resp = self.indexer.transaction(txid)
            txn = resp["transaction"]
            confirmed_round = txn.get("confirmed-round")
            note_b64 = txn.get("note")
        except IndexerHTTPError:
            try:
                txn = self.algod.pending_transaction_info(txid)
                confirmed_round = txn.get("confirmed-round") or None
                note_b64 = txn.get("txn", {}).get("txn", {}).get("note")
            except Exception as exc:
                raise AlgorandUnavailableError(f"Transaction {txid} not found: {exc}")
        except Exception as exc:
            raise AlgorandUnavailableError(f"Indexer lookup failed: {exc}")

        note_obj = None
        if note_b64:
            try:
                if isinstance(note_b64, (bytes, bytearray)):
                    raw = bytes(note_b64)
                else:
                    raw = base64.b64decode(note_b64)
                note_obj = json.loads(raw.decode("utf-8"))
            except Exception:
                note_obj = None

        return {
            "txid": txid,
            "confirmed_round": confirmed_round,
            "confirmed": confirmed_round is not None,
            "note": note_obj,
            "explorer_url": self.explorer_url(txid),
        }

    def verify_anchor(self, *, txid: str, expected_evidence_id: str, expected_sha256_hex: str) -> dict:
        """Full independent verification: fetch txn -> decode note -> compare
        hash from chain against the hash we were asked to check."""
        info = self.get_transaction(txid)
        note = info.get("note") or {}
        anchored_hash = note.get("sha256")
        anchored_evidence_id = note.get("evidence_id")

        hash_match = bool(anchored_hash) and anchored_hash == expected_sha256_hex
        id_match = bool(anchored_evidence_id) and anchored_evidence_id == expected_evidence_id

        return {
            "txid": txid,
            "confirmed": info["confirmed"],
            "confirmed_round": info["confirmed_round"],
            "anchored_hash": anchored_hash,
            "anchored_evidence_id": anchored_evidence_id,
            "expected_hash": expected_sha256_hex,
            "hash_match": hash_match,
            "evidence_id_match": id_match,
            "verified": info["confirmed"] and hash_match and id_match,
            "explorer_url": info["explorer_url"],
            "note": note,
        }


@lru_cache
def get_algorand_client() -> AlgorandClient:
    return AlgorandClient()
