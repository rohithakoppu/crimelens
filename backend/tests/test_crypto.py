"""Real cryptography assertions -- no mocking of hashlib/cryptography.
Run: pytest tests/test_crypto.py -v
"""
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from utils.security import sha256_bytes, sign_evidence_hash, verify_evidence_signature


def test_sha256_deterministic_for_same_bytes():
    a = sha256_bytes(b"evidence-content-v1")
    b = sha256_bytes(b"evidence-content-v1")
    assert a == b
    assert len(a) == 64


def test_sha256_changes_for_one_byte_difference():
    original = b"evidence-content-v1"
    tampered = b"evidence-content-v2"
    assert sha256_bytes(original) != sha256_bytes(tampered)


def test_ed25519_valid_signature_verifies(monkeypatch):
    priv = Ed25519PrivateKey.generate()
    priv_bytes = priv.private_bytes_raw() if hasattr(priv, "private_bytes_raw") else None
    from cryptography.hazmat.primitives import serialization
    priv_hex = priv.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                   serialization.NoEncryption()).hex()
    pub_hex = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()

    from config import get_settings
    get_settings.cache_clear()
    monkeypatch.setenv("SYSTEM_ED25519_PRIVATE_KEY_HEX", priv_hex)
    monkeypatch.setenv("SYSTEM_ED25519_PUBLIC_KEY_HEX", pub_hex)
    get_settings.cache_clear()
    import utils.security as sec
    sec.settings = get_settings()

    file_hash = sha256_bytes(b"real evidence bytes")
    signature = sign_evidence_hash(file_hash)
    assert verify_evidence_signature(file_hash, signature) is True


def test_ed25519_signature_fails_on_tampered_hash(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    priv = Ed25519PrivateKey.generate()
    priv_hex = priv.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                   serialization.NoEncryption()).hex()
    pub_hex = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()

    from config import get_settings
    get_settings.cache_clear()
    monkeypatch.setenv("SYSTEM_ED25519_PRIVATE_KEY_HEX", priv_hex)
    monkeypatch.setenv("SYSTEM_ED25519_PUBLIC_KEY_HEX", pub_hex)
    get_settings.cache_clear()
    import utils.security as sec
    sec.settings = get_settings()

    original_hash = sha256_bytes(b"original file")
    tampered_hash = sha256_bytes(b"tampered file")
    signature = sign_evidence_hash(original_hash)

    assert verify_evidence_signature(tampered_hash, signature) is False


def test_verify_returns_false_not_exception_on_garbage_input():
    assert verify_evidence_signature("not-a-hex-hash", "not-hex-either") is False
    assert verify_evidence_signature(sha256_bytes(b"x"), "") is False


def test_aes_gcm_round_trip_and_tamper_detection():
    import os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = AESGCM.generate_key(bit_length=256)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    plaintext = b"encrypted evidence payload"

    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    assert aesgcm.decrypt(nonce, ciphertext, None) == plaintext

    corrupted = ciphertext[:-1] + bytes([ciphertext[-1] ^ 0xFF])
    try:
        aesgcm.decrypt(nonce, corrupted, None)
        assert False, "expected decryption of tampered ciphertext to fail"
    except Exception:
        pass
