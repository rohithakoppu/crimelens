import os
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


class Settings(BaseSettings):
    # Anchored to this file's own directory, not the process's current
    # working directory -- otherwise launching uvicorn from anywhere other
    # than backend/ (a different terminal tab, an IDE run config, etc.)
    # silently loads no .env at all and every setting falls back to its
    # empty default, with no error.
    model_config = SettingsConfigDict(env_file=os.path.join(_BACKEND_DIR, ".env"), extra="ignore")

    # Core
    app_name: str = "EvidenceChain AI"
    environment: str = "development"
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 120

    # Firebase -- data/auth architecture. Firestore holds all application
    # data (users, cases, evidence metadata, custody events, camera events,
    # blockchain anchors, API/x402 records). Firebase Auth handles user
    # login; the backend never sees passwords, only verifies ID tokens.
    # Firebase Cloud Storage is intentionally NOT used (requires the paid
    # Blaze plan) -- evidence files are stored locally instead, see
    # storage/object_store.py.
    #
    # If Firestore/Auth is unconfigured, the app still starts: every
    # Firestore-backed endpoint returns 503 "Firebase not configured"
    # instead of silently falling back to fake data.
    firebase_project_id: str = ""
    firebase_storage_bucket: str = ""  # unused by object_store.py; kept only if firebase-admin needs it initialized
    firebase_web_api_key: str = ""  # public key from the web config, used server-side to proxy email/password login
    firebase_service_account_json: str = ""  # full JSON, inline (e.g. from a secret manager)
    firebase_service_account_path: str = os.path.join(_BACKEND_DIR, "firebase-service-account.json")

    encryption_key: str = "0" * 64  # 32-byte hex AES-256 key, override in .env for real deployments

    # Evidence file storage: application-managed local disk, AES-256-GCM
    # encrypted (storage/object_store.py). Firebase Cloud Storage requires
    # the Blaze billing plan, which this prototype does not require -- only
    # Firestore (metadata) and Firebase Auth are used from Firebase.
    local_storage_dir: str = os.path.join(_BACKEND_DIR, "data", "evidence")

    # Blockchain -- Algorand Testnet.
    algorand_network: str = "testnet"
    algorand_algod_server: str = "https://testnet-api.algonode.cloud"
    algorand_algod_port: int = 443
    algorand_algod_token: str = ""  # AlgoNode's public endpoints need no token
    algorand_indexer_server: str = "https://testnet-idx.algonode.cloud"
    algorand_indexer_port: int = 443
    algorand_indexer_token: str = ""
    algorand_explorer_base: str = "https://testnet.explorer.perawallet.app/tx"
    algorand_app_explorer_base: str = "https://testnet.explorer.perawallet.app/application"

    # Phase 3: the real CrimeLens Evidence Registry application
    # (blockchain/algorand/contracts/evidence_registry.py), deployed via
    # scripts/deploy_contract.py. Empty until an actual ApplicationCreateTxn
    # has been confirmed on Testnet -- callers must treat "" as
    # NOT_CONFIGURED, never guess or fabricate an ID.
    algorand_app_id: str = ""

    # System account that signs/funds every anchor transaction (both the
    # legacy note-based anchor and the Phase 3 smart-contract registration
    # calls). Never sent to the frontend. If unset, the app still starts --
    # blockchain status shows unavailable/configuration-required and
    # anchoring is queued as pending rather than faked.
    system_algorand_mnemonic: str = ""

    # Digital signatures (Sec 9): Ed25519, chosen because it's a modern
    # signature scheme independent of whichever chain we anchor to (unlike
    # the prior ECDSA/secp256k1 code, which was only there because it's what
    # EVM's `msg.sender` checks require). The system key signs
    # sha256(evidence file) at ingest time; the public key lets anyone verify
    # that signature offline, without needing the private key or the chain.
    system_ed25519_private_key_hex: str = ""
    system_ed25519_public_key_hex: str = ""

    # Used to build the public verification URL embedded in QR codes.
    frontend_base_url: str = "http://localhost:5173"

    # Upload size ceiling for evidence files/segments -- real, enforced
    # policy limit (413 Payload Too Large past this), not merely
    # aspirational. 200MB comfortably covers a 15s 720p WebM chunk many
    # times over while still bounding worst-case memory use per request.
    max_upload_bytes: int = 200 * 1024 * 1024

    # AI
    ollama_base_url: str = "http://localhost:11434"
    use_llm_summarizer: bool = False

    # Real-time camera obstruction detection (Sec 5): brightness + Laplacian
    # (blur) variance analysis, requiring N consecutive flagged frames before
    # declaring an incident -- avoids false positives from a single dark or
    # motion-blurred frame.
    analysis_fps: int = 5
    obstruction_threshold_brightness: float = 30.0
    obstruction_threshold_laplacian: float = 100.0
    consecutive_frames_required: int = 5

    # x402-compatible payment-aware API access (Sec 6)
    x402_free_tier_requests_per_hour: int = 10
    x402_pro_tier_requests_per_hour: int = 1000
    x402_price_per_request_algo: float = 0.01
    x402_demo_mode: bool = True  # honest label: no real settlement network is wired up yet


@lru_cache
def get_settings() -> Settings:
    return Settings()
