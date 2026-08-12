from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

import pyotp
import requests
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from api.deps import get_current_user, require_roles
from config import get_settings
from db import repository as repo
from firebase.client import FirebaseUnavailableError, get_firebase_client

router = APIRouter(prefix="/auth", tags=["auth"])
bearer_scheme = HTTPBearer(auto_error=False)

VALID_ROLES = {"admin", "investigator", "viewer"}
IDENTITY_TOOLKIT_SIGNIN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"

# requests' own `timeout=` only bounds the connect/read phases *after* DNS
# resolution succeeds -- a stalled/unreachable resolver can block far longer
# than that. Running the call in a worker thread with a hard `.result()`
# deadline enforces a real wall-clock bound regardless of what's stuck
# underneath, so a login request never hangs indefinitely with the UI stuck
# on an unexplained spinner.
_login_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="firebase-login")
_LOGIN_NETWORK_DEADLINE_SECONDS = 12


class LoginRequest(BaseModel):
    email: str
    password: str
    mfa_code: str | None = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    name: str


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest):
    """Real Firebase Authentication: proxies to the Identity Toolkit REST API
    (the same endpoint the Firebase JS SDK calls internally) using the
    project's public web API key, so the backend never sees or stores
    passwords itself. The returned Firebase ID token is the access_token
    used for every subsequent request; get_current_user verifies it against
    Firebase on every call.
    """
    settings = get_settings()
    if not settings.firebase_web_api_key:
        raise HTTPException(status_code=503, detail="Firebase not configured (missing FIREBASE_WEB_API_KEY)")

    def _call_identity_toolkit() -> requests.Response:
        return requests.post(
            IDENTITY_TOOLKIT_SIGNIN_URL,
            params={"key": settings.firebase_web_api_key},
            json={"email": payload.email, "password": payload.password, "returnSecureToken": True},
            timeout=10,
        )

    try:
        resp = _login_executor.submit(_call_identity_toolkit).result(timeout=_LOGIN_NETWORK_DEADLINE_SECONDS)
    except (requests.exceptions.RequestException, FutureTimeoutError) as exc:
        # DNS failure / connection timeout / network unreachable to Firebase's
        # Identity Toolkit -- previously unhandled, so it surfaced as a bare
        # 500 with no diagnosis, and could hang well past the 10s connect
        # timeout since that timeout doesn't bound DNS resolution itself (a
        # stalled resolver blocks before requests' own timeout ever starts
        # counting). Running the call in a worker thread with a hard
        # `.result()` deadline guarantees this endpoint always returns within
        # ~12s instead of leaving the login button spinning indefinitely.
        # This affects every account equally (not role-specific), but a
        # hung/opaque failure here looks identical to "login doesn't work"
        # from whichever account someone happens to test with.
        raise HTTPException(
            status_code=503,
            detail="Authentication service unavailable. Please check backend/network configuration.",
        ) from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    id_token = resp.json()["idToken"]
    uid = resp.json()["localId"]

    profile = repo.get_user(uid)
    if profile is None:
        raise HTTPException(status_code=401, detail="No EvidenceChain profile for this account")

    if profile.get("mfa_enabled"):
        if not payload.mfa_code:
            raise HTTPException(status_code=401, detail="MFA code required")
        totp = pyotp.TOTP(profile["mfa_secret"])
        if not totp.verify(payload.mfa_code, valid_window=1):
            raise HTTPException(status_code=401, detail="Invalid MFA code")

    return LoginResponse(access_token=id_token, role=profile["role"], name=profile["name"])


@router.post("/session")
def create_session(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)):
    """Called right after Firebase client-side sign-in (Google popup or
    email/password) with the resulting Firebase ID token. Verifies the token
    for real against Firebase Auth, then either returns the caller's existing
    EvidenceChain profile or -- for a Google sign-in with no prior admin
    registration -- creates one with the default least-privilege role
    'viewer'. This is real self-service provisioning tied to a real verified
    identity, not a bypass: an admin still has to promote the account for
    investigator/admin access via /auth/register or the Admin page.
    """
    if credentials is None:
        raise HTTPException(status_code=401, detail="Missing credentials")

    try:
        client = get_firebase_client()
        decoded = client.verify_id_token(credentials.credentials)
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    uid = decoded["uid"]
    profile = repo.get_user(uid)
    if profile is not None:
        return profile

    name = decoded.get("name") or decoded.get("email", "").split("@")[0] or "New User"
    email = decoded.get("email", "")
    return repo.create_user(uid, name, email, "viewer")


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str


@router.post("/register")
def register(payload: RegisterRequest, _: dict = Depends(require_roles("admin"))):
    """Admin-only: creates a real Firebase Auth user plus a Firestore profile
    with the role that drives RBAC (Firebase Auth itself has no role
    concept, so the role of record lives in Firestore, keyed by uid)."""
    if payload.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(VALID_ROLES)}")

    try:
        client = get_firebase_client()
        uid = client.get_or_create_auth_user(payload.email, payload.password, payload.name)
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if repo.get_user(uid) is not None:
        raise HTTPException(status_code=409, detail="User already registered")

    return repo.create_user(uid, payload.name, payload.email, payload.role)


class MfaSetupResponse(BaseModel):
    secret: str
    otpauth_url: str


@router.post("/mfa/setup", response_model=MfaSetupResponse)
def setup_mfa(user: dict = Depends(get_current_user)):
    secret = pyotp.random_base32()
    repo.set_mfa(user["id"], secret, True)
    totp = pyotp.TOTP(secret)
    url = totp.provisioning_uri(name=user["email"], issuer_name="EvidenceChain AI")
    return MfaSetupResponse(secret=secret, otpauth_url=url)
