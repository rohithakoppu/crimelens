import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

from config import get_settings

settings = get_settings()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def create_access_token(subject: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": subject,
        "role": role,
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate_evidence_id() -> str:
    """EVD-<year>-<6 random hex chars>. Uniqueness is enforced by the
    evidence store's primary key, not by this generator alone."""
    year = datetime.now(timezone.utc).year
    suffix = uuid.uuid4().hex[:6].upper()
    return f"EVD-{year}-{suffix}"


def sign_evidence_hash(sha256_hex: str) -> str:
    """Ed25519-signs the evidence's SHA-256 hash with the system private key.

    Returns the signature as hex. Raises if no signing key is configured --
    a missing key must never silently produce a fake "valid" signature.
    """
    if not settings.system_ed25519_private_key_hex:
        raise RuntimeError("SYSTEM_ED25519_PRIVATE_KEY_HEX not configured")
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(settings.system_ed25519_private_key_hex))
    signature = key.sign(bytes.fromhex(sha256_hex))
    return signature.hex()


def verify_evidence_signature(sha256_hex: str, signature_hex: str, public_key_hex: str | None = None) -> bool:
    """Verifies an Ed25519 signature over a SHA-256 hash using the public key.
    Returns False (never raises) on any malformed input or mismatch -- the
    caller decides how to present that as a verification-failed result."""
    pub_hex = public_key_hex or settings.system_ed25519_public_key_hex
    if not pub_hex or not signature_hex:
        return False
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(pub_hex))
        pub.verify(bytes.fromhex(signature_hex), bytes.fromhex(sha256_hex))
        return True
    except (InvalidSignature, ValueError):
        return False


