"""Deploys the CrimeLens Evidence Registry application to Algorand Testnet.

Real deployment only -- this submits an actual ApplicationCreateTxn signed
by the configured system account and waits for real confirmation. It never
prints a fabricated application ID: if the account is unfunded or the
network is unreachable, it fails loudly with the real error and exits
non-zero.

Usage (from backend/):
    ./venv/Scripts/python.exe scripts/deploy_contract.py

On success, prints the real Application ID and writes it to
`backend/.deployed_app_id` as a convenience -- you still need to copy it
into `ALGORAND_APP_ID` in backend/.env yourself (deployment and
configuration are kept as separate, explicit steps on purpose).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from algosdk import account, mnemonic  # noqa: E402
from algosdk.error import AlgodHTTPError  # noqa: E402
from algosdk.transaction import ApplicationCreateTxn, OnComplete, StateSchema, wait_for_confirmation  # noqa: E402
from algosdk.v2client import algod  # noqa: E402

from blockchain.algorand.contracts.evidence_registry import compile_approval, compile_clear  # noqa: E402
from config import get_settings  # noqa: E402


def compile_program(client: algod.AlgodClient, source: str) -> bytes:
    result = client.compile(source)
    import base64

    return base64.b64decode(result["result"])


def main() -> int:
    settings = get_settings()

    if not settings.system_algorand_mnemonic.strip():
        print("BLOCKCHAIN DEPLOYMENT BLOCKED — SYSTEM_ALGORAND_MNEMONIC is not configured.")
        return 1

    private_key = mnemonic.to_private_key(settings.system_algorand_mnemonic.strip())
    address = account.address_from_private_key(private_key)

    client = algod.AlgodClient(
        settings.algorand_algod_token,
        settings.algorand_algod_server,
        headers={"X-API-Key": settings.algorand_algod_token} if settings.algorand_algod_token else {},
    )

    try:
        account_info = client.account_info(address)
    except Exception as exc:
        print(f"BLOCKCHAIN DEPLOYMENT BLOCKED — could not reach Algorand node: {exc}")
        return 1

    balance = account_info.get("amount", 0)
    print(f"Deploying account: {address}")
    print(f"Current balance:   {balance} microAlgos ({balance / 1_000_000} ALGO)")

    # A bare app-create transaction costs ~1000 microAlgos in fees alone,
    # and the account then needs to hold its own minimum balance on top of
    # that (100000 microAlgos) plus, separately, enough to fund box storage
    # for every evidence registration afterward. This floor is deliberately
    # conservative -- it does not guarantee later registrations succeed, it
    # only checks whether deployment itself is possible.
    MIN_DEPLOY_BALANCE = 200_000
    if balance < MIN_DEPLOY_BALANCE:
        print(
            f"BLOCKCHAIN DEPLOYMENT BLOCKED — INSUFFICIENT ALGO. "
            f"Account has {balance} microAlgos, needs at least {MIN_DEPLOY_BALANCE} to safely deploy. "
            f"Fund {address} via https://bank.testnet.algorand.network/ and retry."
        )
        return 1

    approval_teal = compile_approval()
    clear_teal = compile_clear()

    try:
        approval_bytes = compile_program(client, approval_teal)
        clear_bytes = compile_program(client, clear_teal)
    except AlgodHTTPError as exc:
        print(f"BLOCKCHAIN DEPLOYMENT BLOCKED — TEAL compilation via algod failed: {exc}")
        return 1

    global_schema = StateSchema(num_uints=0, num_byte_slices=0)  # no global state -- boxes only
    local_schema = StateSchema(num_uints=0, num_byte_slices=0)  # no per-account opt-in state

    try:
        params = client.suggested_params()
        txn = ApplicationCreateTxn(
            sender=address,
            sp=params,
            on_complete=OnComplete.NoOpOC,
            approval_program=approval_bytes,
            clear_program=clear_bytes,
            global_schema=global_schema,
            local_schema=local_schema,
        )
        signed = txn.sign(private_key)
        txid = client.send_transaction(signed)
        print(f"Submitted transaction: {txid}")
        confirmed = wait_for_confirmation(client, txid, 8)
    except Exception as exc:
        print(f"BLOCKCHAIN DEPLOYMENT BLOCKED — real deployment transaction failed: {exc}")
        return 1

    app_id = confirmed["application-index"]
    print(f"\nDEPLOYED — real Application ID: {app_id}")
    print(f"Confirmed round: {confirmed.get('confirmed-round')}")
    print(f"Transaction ID: {txid}")
    print(f"\nAdd this to backend/.env:\n  ALGORAND_APP_ID={app_id}")

    marker_path = Path(__file__).resolve().parent.parent / ".deployed_app_id"
    marker_path.write_text(str(app_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
