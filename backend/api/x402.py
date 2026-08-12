"""x402-compatible payment-aware API access.

This is real HTTP 402 Payment Required, not API-key rate limiting relabeled:
every request identifies itself with an API key (free/pro/enterprise tier,
purely for identification + quota bucketing), and once that tier's
requests-per-hour quota is exhausted, the endpoint responds 402 with a
machine-readable payment requirement instead of silently blocking or
faking success.

Settlement is genuinely checked, not simulated: the required "payment" is a
real ALGO transfer on Algorand Testnet to the system account, and this
module verifies it by independently looking the transaction up via the
Algorand Indexer (blockchain/algorand/client.py) -- confirming amount,
receiver, and that the txid hasn't been redeemed before -- before granting
access. If Algorand itself is unavailable, payment verification correctly
fails closed (no access) rather than assuming success.
"""
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.deps import require_roles
from blockchain.algorand.client import AlgorandUnavailableError, get_algorand_client
from config import get_settings
from custody import verification as verification_service
from custody.verification import VerificationUnavailableError
from db import repository as repo
from firebase.client import FirebaseUnavailableError

router = APIRouter(prefix="/api/v1", tags=["x402"])

TIER_LIMITS = {
    "free": "x402_free_tier_requests_per_hour",
    "pro": "x402_pro_tier_requests_per_hour",
    "enterprise": None,  # None => unlimited, per policy
}


def _tier_limit(tier: str) -> int | None:
    settings = get_settings()
    field = TIER_LIMITS.get(tier)
    return getattr(settings, field) if field else None


def _price_microalgos() -> int:
    return int(get_settings().x402_price_per_request_algo * 1_000_000)


def _payment_requirements(resource: str) -> dict:
    settings = get_settings()
    chain = get_algorand_client()
    return {
        "x402Version": 1,
        "accepts": [{
            "scheme": "exact",
            "network": f"algorand-{settings.algorand_network}",
            "asset": "ALGO",
            "amountMicroAlgos": _price_microalgos(),
            "amountAlgo": settings.x402_price_per_request_algo,
            "payTo": chain.address,
            "resource": resource,
            "description": "EvidenceChain AI verification API -- pay-per-request beyond your tier's free quota",
        }],
        "demoMode": settings.x402_demo_mode,
        "note": (
            "DEMO MODE: this project verifies real payments via the Algorand Indexer once you submit one, "
            "but does not (yet) run a hosted x402 facilitator/relayer. Pay the 'payTo' address the exact "
            "amount on Algorand Testnet yourself, then retry with header X-PAYMENT: <txid>."
            if settings.x402_demo_mode else "Live settlement enabled."
        ),
    }


@router.get("/payment/requirements")
def payment_requirements(resource: str = "/api/v1/verification/verify"):
    return _payment_requirements(resource)


class ClientCreate(BaseModel):
    name: str
    tier: str = "free"


@router.post("/clients")
def create_client(payload: ClientCreate, _: dict = Depends(require_roles("admin"))):
    if payload.tier not in TIER_LIMITS:
        raise HTTPException(status_code=400, detail=f"tier must be one of {list(TIER_LIMITS)}")
    return repo.create_api_client(payload.name, payload.tier)


@router.get("/clients")
def list_clients(_: dict = Depends(require_roles("admin"))):
    return repo.list_api_clients()


@router.get("/usage")
def usage(x_api_key: str = Header(...)):
    client = repo.get_api_client_by_key(x_api_key)
    if client is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    limit = _tier_limit(client["tier"])
    used = repo.count_usage_last_hour(client["id"])
    return {
        "client": client["name"], "tier": client["tier"],
        "limit_per_hour": limit if limit is not None else "unlimited",
        "used_last_hour": used,
        "remaining": (max(0, limit - used) if limit is not None else "unlimited"),
    }


def _verify_payment(txid: str, resource: str, client_id: str | None) -> dict:
    """Real settlement check against Algorand Testnet. Never returns
    verified=True unless the Indexer actually shows a confirmed transfer of
    at least the required amount to the system address, and the txid hasn't
    already been redeemed for a prior request."""
    existing = repo.get_payment_record(txid)
    if existing is not None and existing["status"] == "SETTLED":
        return {"verified": False, "reason": "Payment already redeemed for a previous request"}

    try:
        chain = get_algorand_client()
        info = chain.get_transaction(txid)
    except AlgorandUnavailableError as exc:
        return {"verified": False, "reason": f"Could not verify payment on Algorand: {exc}"}

    if not info["confirmed"]:
        return {"verified": False, "reason": "Payment transaction not yet confirmed"}

    # We don't have the raw txn amount/receiver from get_transaction (it
    # only decodes the note) -- pull those from the Indexer response directly.
    try:
        raw = chain.indexer.transaction(txid)["transaction"]["payment-transaction"]
        amount = raw["amount"]
        receiver = raw["receiver"]
        payer = chain.indexer.transaction(txid)["transaction"]["sender"]
    except Exception as exc:
        return {"verified": False, "reason": f"Transaction is not a payment transaction: {exc}"}

    if receiver != chain.address:
        return {"verified": False, "reason": "Payment was not sent to the EvidenceChain system address"}
    if amount < _price_microalgos():
        return {"verified": False, "reason": f"Payment amount {amount} microAlgos is below required {_price_microalgos()}"}

    repo.create_payment_record(txid, resource, amount, client_id)
    repo.mark_payment_settled(txid, payer)
    return {"verified": True, "amount_microalgos": amount, "payer": payer}


def _run_verification(evidence_id: str) -> dict:
    """Delegates to custody.verification.verify_evidence() -- the exact same
    function GET /evidence/{id}/verify uses. This is not a reimplementation:
    the paid x402 path and the free public path call the identical code, so
    they can never diverge on what counts as AUTHENTIC (including segment-
    chain and Evidence Root Hash checks, added in Phase 2)."""
    try:
        result = verification_service.verify_evidence(evidence_id, record_access=False)
    except VerificationUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="Evidence not found")
    return result


class VerifyRequest(BaseModel):
    evidence_id: str | None = None


@router.post("/evidence/{evidence_id}/verify")
async def paid_verify_by_path(
    evidence_id: str,
    x_api_key: str = Header(...),
    x_payment: str | None = Header(default=None, alias="X-PAYMENT"),
):
    return await _paid_verify(evidence_id, x_api_key, x_payment)


@router.post("/verification/verify")
async def paid_verify_by_body(
    payload: VerifyRequest,
    x_api_key: str = Header(...),
    x_payment: str | None = Header(default=None, alias="X-PAYMENT"),
):
    if not payload.evidence_id:
        raise HTTPException(status_code=400, detail="evidence_id is required")
    return await _paid_verify(payload.evidence_id, x_api_key, x_payment)


async def _paid_verify(target_id: str, x_api_key: str, x_payment: str | None):
    try:
        client = repo.get_api_client_by_key(x_api_key)
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if client is None or not client.get("active", True):
        raise HTTPException(status_code=401, detail="Invalid or inactive API key")

    resource = f"/api/v1/evidence/{target_id}/verify"
    limit = _tier_limit(client["tier"])
    used = repo.count_usage_last_hour(client["id"])
    within_quota = limit is None or used < limit

    if not within_quota:
        if not x_payment:
            repo.record_api_usage(client["id"], resource, status="payment_required")
            return JSONResponse(status_code=402, content=_payment_requirements(resource))

        payment = _verify_payment(x_payment, resource, client["id"])
        if not payment["verified"]:
            repo.record_api_usage(client["id"], resource, status="payment_rejected")
            return JSONResponse(
                status_code=402,
                content={**_payment_requirements(resource), "paymentRejectedReason": payment["reason"]},
            )
        repo.record_api_usage(client["id"], resource, status="granted", paid_with_txid=x_payment)
        return {"paid": True, "payment": payment, "result": _run_verification(target_id)}

    repo.record_api_usage(client["id"], resource, status="granted")
    return {"paid": False, "tier": client["tier"], "result": _run_verification(target_id)}

