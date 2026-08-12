# EvidenceChain AI

A forensic evidence integrity and verification platform. It creates a
cryptographically verifiable chain of custody from the moment a camera
captures footage to the moment anyone — including someone who doesn't trust
the platform operator — independently verifies it.

## The problem

Digital/video evidence can be modified, replaced, deleted, or have its
custody history questioned. Once a file leaves the camera, there's usually
no way to prove it's the same file that was originally captured, who's
touched it since, or whether it's been tampered with.

## The solution

Every piece of evidence goes through a real, deterministic pipeline:

```
REAL WEBCAM
    │
REAL VIDEO CAPTURE (MediaRecorder, 30s chunks)
    │
OPENCV OBSTRUCTION DETECTION (live, per-frame)
    │
EVIDENCE ID  (EVD-YYYY-XXXXXX)
    │
SHA-256 hash of the raw file
    │
Ed25519 digital signature of that hash
    │
AES-256-GCM encryption of the file
    │
Firebase Storage (encrypted file)  +  Firestore (metadata)
    │
Algorand Testnet anchor (hash committed in a transaction note)
    │
Hash-linked chain-of-custody event log
    │
Deterministic verification (AUTHENTIC / TAMPERED)
    │
x402-gated API access for external systems
```

### What this honestly proves — and what it doesn't

Blockchain anchoring proves:
- the file has a specific SHA-256 hash
- that hash was registered/anchored at a specific time, independently checkable by anyone
- the file has not changed since that hash was created
- the Ed25519 signature over the hash is valid
- custody events form a tamper-evident, hash-linked chain

It does **not** prove:
- the camera was truthful, or that nothing was staged in front of it
- the scene wasn't manipulated before capture
- anyone's guilt or innocence

A production version would additionally need trusted capture hardware
(HSM/TEE), a certified chain-of-custody procedure, redundant storage, and
legal/forensic compliance review. This is a hackathon MVP/prototype.

## Architecture

| Layer | Tech | Why |
|---|---|---|
| Frontend | React 19 + TypeScript, Vite, Tailwind CSS v4 | Fast, typed, no framework lock-in |
| Backend | FastAPI (Python) | Async, typed, easy to reason about for a security-sensitive app |
| Database | **Cloud Firestore** | Flexible schema for evidence/custody/camera-event documents, real-time capable |
| File storage | **Firebase Storage** | Actual encrypted evidence files — never Firestore, never the blockchain |
| Auth | **Firebase Authentication** | Real email/password auth; backend never stores passwords, only verifies ID tokens |
| Blockchain | **Algorand Testnet** (`algosdk`, Algod + Indexer) | See below |
| Computer vision | OpenCV (obstruction, blur, blackout, rotation drift), optional YOLOv8n | Deterministic, explainable classical CV; ML only where it adds real value |
| Payments/API access | **x402-compatible HTTP 402** layer, settled via real Algorand micropayments | See below |

### Why Algorand

The earlier version of this project used Polygon/Hardhat/Solidity/web3.py.
That has been **completely removed**. The final architecture anchors evidence
hashes as the `note` field of a minimal (0 ALGO self-payment) real Algorand
Testnet transaction — no custom smart contract, because a note is sufficient
to carry `{evidence_id, sha256, case_id, camera_id, timestamp}` and keeps
everything except that metadata off-chain. See `backend/blockchain/algorand/client.py`.

Every anchor is a **real, submitted, confirmed Testnet transaction** —
never a fabricated txid. If the system account isn't funded or the network
is unreachable, evidence creation still succeeds and `blockchain_status`
honestly reports `UNAVAILABLE`/`PENDING`, with a retry endpoint
(`POST /evidence/{id}/anchor`) once it's fixed.

Verification independently re-fetches the transaction via the **Algorand
Indexer**, decodes the note, and compares the anchored hash against the
hash being verified — it does not just trust a cached database field.

### Why x402

Algorand anchoring solves evidence *provenance*. x402 solves *controlled,
paid programmatic access* to the verification API — the scenario where a
forensic company or insurer wants to verify thousands of evidence records
via API rather than by hand.

`POST /api/v1/verification/verify` requires an API key (free/pro/enterprise
tier, purely for identification and hourly-quota bucketing). Once a tier's
quota is exhausted, the endpoint returns a genuine `HTTP 402 Payment
Required` with a machine-readable payment requirement
(`GET /api/v1/payment/requirements`). Settlement is **not simulated**: the
required payment is a real ALGO transfer to the system's Algorand address,
and `backend/api/x402.py` verifies it by independently looking the
transaction up via the Algorand Indexer — checking amount, receiver, and
that the txid hasn't already been redeemed — before granting access. There
is no hosted x402 facilitator/relayer wired up (that would need a separate
paid service); this project verifies settlement directly against Algorand
itself, which is honest and demonstrable without one.

### Cryptography

- **SHA-256** (`hashlib`) over the raw evidence bytes — deterministic, same
  file always produces the same hash, any change produces a different one.
- **Ed25519** (`cryptography` library) signs the SHA-256 hash with a system
  keypair; the public key verifies it. Chosen because it's a modern, fast
  signature scheme independent of any particular chain (the old design used
  ECDSA/secp256k1 only because that's what EVM's `msg.sender` needs).
- **AES-256-GCM** (`cryptography.hazmat`) encrypts the file before it's
  ever written to Firebase Storage, with a random 12-byte nonce per object
  and an authentication tag. The key lives only in backend config, never the
  frontend.

### Real-time camera obstruction detection

`backend/ai/obstruction.py` runs actual OpenCV analysis on each frame: mean
brightness and Laplacian variance (blur). `backend/ai/camera_state.py` is a
per-camera state machine requiring `CONSECUTIVE_FRAMES_REQUIRED` consecutive
flagged (or clear) frames before declaring an incident, to avoid false
positives from one bad frame. Confidence and downtime are both **computed
from the actual frames and timestamps**, never hardcoded. See
`backend/tests/test_obstruction.py` for the full behavioral test suite,
including a regression test for a real bug found during manual testing
(state must still flip to `OBSTRUCTED` even if the Firestore write fails).

### Chain of custody

Every meaningful action on a piece of evidence (`EVIDENCE_CREATED`,
`HASH_GENERATED`, `SIGNED`, `ENCRYPTED`, `STORED`, `BLOCKCHAIN_ANCHORED`,
`ACCESSED`, `VERIFICATION_REQUESTED`, etc.) appends one event to
`evidence/{id}/custody_events` in Firestore. Each event's hash commits to
its own fields **and** the previous event's hash
(`backend/custody/chain.py`). Editing, reordering, or deleting an earlier
event breaks the chain from that point forward — `verify_chain()`
recomputes every hash and reports exactly where the chain broke. Tested in
`backend/tests/test_custody.py` against the pure hashing logic (no live
Firestore needed to prove the algorithm is correct).

### Verification engine

`GET /evidence/{id}/verify` (public, no auth) runs the full deterministic
check: recompute SHA-256 from the stored (decrypted) file → compare to the
stored hash → verify the Ed25519 signature → re-verify the Algorand anchor
via Indexer → verify the custody chain. Returns `AUTHENTIC` **only if every
check passes**; otherwise `TAMPERED`, with the exact stored vs. current hash
shown side by side. The same logic is reused (not duplicated/diverged) by
the paid API path in `backend/api/x402.py`.

## Security

- Passwords never touch the backend — Firebase Authentication handles them;
  the backend only verifies ID tokens (`firebase_admin.auth.verify_id_token`).
- Private keys (Algorand mnemonic, Ed25519 private key, AES key, Firebase
  service account) live only in `backend/.env`, gitignored, never sent to
  the frontend.
- RBAC (`admin` / `investigator` / `viewer`) is enforced in FastAPI
  dependencies (`api/deps.py`), not just displayed in the UI.
- CORS is restricted to the dev frontend origin; global exception handlers
  ensure a missing Firebase/Algorand/Storage config always fails as a clean
  503 with CORS headers intact, never a raw crash.
- File uploads go through multipart form validation; encryption keys and
  service-account credentials are never logged.

## Project structure

```
backend/
  api/            auth, evidence, case, camera, admin, assistant, x402
  ai/             obstruction detection, tamper checks, object detection, summarizer, assistant
  blockchain/algorand/   Algod + Indexer client, anchoring, verification
  custody/        hash-linked chain-of-custody log
  db/             Firestore repository (replaces the old SQLAlchemy layer)
  firebase/       Firebase Admin SDK bootstrap (Firestore + Storage + Auth)
  storage/        AES-256-GCM envelope encryption + Firebase Storage
  utils/          JWT-independent security helpers, PDF certificate generation
  tests/          pytest suite (crypto, custody, obstruction)
frontend/
  src/pages/      Login, Dashboard, LiveCamera, CaseDetail, EvidenceDetail,
                  VerifyPublic, ApiAccess, Admin
ingestion/        edge_agent.py -- polls a folder and posts files to /evidence/ingest
crimelens/        an earlier, unused AlgoKit scaffold (default template only,
                  no custom logic) -- kept for reference, not part of the running app
```

## Environment variables

All backend config lives in `backend/.env` (gitignored; see
`backend/.env.example` for the full template).

```env
JWT_SECRET=...

# Firebase -- see "Setup" below for how to get these
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_WEB_API_KEY=
FIREBASE_SERVICE_ACCOUNT_JSON=            # paste the full JSON inline, or:
FIREBASE_SERVICE_ACCOUNT_PATH=firebase-service-account.json

# Algorand Testnet
ALGORAND_NETWORK=testnet
ALGORAND_ALGOD_SERVER=https://testnet-api.algonode.cloud
ALGORAND_ALGOD_PORT=443
ALGORAND_INDEXER_SERVER=https://testnet-idx.algonode.cloud
ALGORAND_INDEXER_PORT=443
ALGORAND_EXPLORER_BASE=https://testnet.explorer.perawallet.app/tx
SYSTEM_ALGORAND_MNEMONIC=                 # 25-word mnemonic of a FUNDED testnet account

# AES-256-GCM key (64 hex chars = 32 bytes)
ENCRYPTION_KEY=

# Ed25519 keypair for evidence signing
SYSTEM_ED25519_PRIVATE_KEY_HEX=
SYSTEM_ED25519_PUBLIC_KEY_HEX=

# Real-time obstruction detection tuning
ANALYSIS_FPS=5
OBSTRUCTION_THRESHOLD_BRIGHTNESS=30
OBSTRUCTION_THRESHOLD_LAPLACIAN=100
CONSECUTIVE_FRAMES_REQUIRED=5

# x402
X402_FREE_TIER_REQUESTS_PER_HOUR=10
X402_PRO_TIER_REQUESTS_PER_HOUR=1000
X402_PRICE_PER_REQUEST_ALGO=0.01
```

Frontend config is just `frontend/.env` → `VITE_API_BASE_URL=http://localhost:8000`.
The frontend never talks to Firebase or Algorand directly — every privileged
operation goes through the backend, so no Firebase web config is needed on
the client.

## Setup

### 1. Backend

```bash
cd backend
python -m venv venv
./venv/Scripts/activate          # Windows; `source venv/bin/activate` on Mac/Linux
pip install -r requirements.txt
```

### 2. Algorand Testnet account

Generate one (or reuse an existing testnet account) and fund it at the
official dispenser:

```bash
python -c "from algosdk import account, mnemonic; sk, addr = account.generate_account(); print('ADDRESS:', addr); print('MNEMONIC:', mnemonic.from_private_key(sk))"
```

Paste the address into https://bank.testnet.algorand.network, then put the
mnemonic in `SYSTEM_ALGORAND_MNEMONIC` in `backend/.env`.

### 3. Ed25519 signing key

```bash
python -c "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as K; from cryptography.hazmat.primitives import serialization as s; k=K.generate(); print(k.private_bytes(s.Encoding.Raw,s.PrivateFormat.Raw,s.NoEncryption()).hex()); print(k.public_key().public_bytes(s.Encoding.Raw,s.PublicFormat.Raw).hex())"
```

Put the two lines into `SYSTEM_ED25519_PRIVATE_KEY_HEX` / `_PUBLIC_KEY_HEX`.

### 4. AES-256-GCM key

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Put it in `ENCRYPTION_KEY`.

### 5. Firebase project

1. Create a project at https://console.firebase.google.com
2. **Authentication** → Sign-in method → enable **Email/Password**
3. **Firestore Database** → create (test mode is fine to start)
4. **Storage** → enable
5. Project settings → **Service accounts** → Generate new private key →
   save the JSON as `backend/firebase-service-account.json` (already
   gitignored), or paste its contents into `FIREBASE_SERVICE_ACCOUNT_JSON`
6. Project settings → General → note your **Project ID**, **Storage
   bucket**, and **Web API key** → put them in `FIREBASE_PROJECT_ID`,
   `FIREBASE_STORAGE_BUCKET`, `FIREBASE_WEB_API_KEY`

Until this is done, the app still runs — every Firebase-backed endpoint
returns a clean `503 Firebase not configured` instead of faking success,
and `/health` reports it honestly.

### 6. Seed demo users + a demo case

```bash
cd backend
python seed.py
```

Creates real Firebase Auth accounts + Firestore profiles:

| Role | Email | Password |
|---|---|---|
| Admin | admin@evidencechain.demo | Admin#12345 |
| Investigator | investigator@evidencechain.demo | Investigator#12345 |
| Viewer | viewer@evidencechain.demo | Viewer#12345 |

### 7. Run it

```bash
cd backend && uvicorn main:app --reload --port 8000
cd frontend && npm install && npm run dev
```

Optional: `pip install ultralytics` in the backend venv to enable real
YOLOv8n object detection (weights auto-download on first use). Without it,
the detection step is clearly labeled `"engine": "stub"` rather than faking
results.

## Testing

```bash
cd backend
pip install pytest
pytest tests/ -v
```

21 tests covering: SHA-256 determinism and tamper-sensitivity, AES-256-GCM
round-trip and tamper rejection, Ed25519 sign/verify (including rejecting a
tampered hash), hash-linked custody chain integrity (valid chain, edited
event, reordered events, deleted event), and the full obstruction
state-machine (threshold behavior, dedup, recovery/downtime calculation,
and the Firestore-unavailable regression case).

```bash
cd frontend
npm run build      # tsc -b && vite build
npm run lint        # oxlint
```

## Demo walkthrough

1. **Dashboard** — shows real Firebase/Algorand connectivity (not
   hardcoded "ONLINE"), case list.
2. **Live Camera** — click *Start Camera* (real `getUserMedia` prompt),
   *Start Monitoring* (real OpenCV frame analysis at `ANALYSIS_FPS`), *Start
   Recording* (real `MediaRecorder`, 30-second auto-chunked evidence
   uploads). Cover the lens: watch it flip to `OBSTRUCTION DETECTED` with a
   computed confidence after `CONSECUTIVE_FRAMES_REQUIRED` frames. Uncover
   it: watch `CAMERA RECOVERED` with a computed downtime.
3. Each recorded chunk shows its real pipeline status: hash → signature →
   encryption → storage → Algorand anchor, with a link to the Algorand
   Explorer once confirmed.
4. **Evidence Detail** — full integrity pillars, custody timeline, "Verify
   now" (recomputes everything live).
5. **Public Verify** (`/verify`, no login) — paste an evidence ID; upload
   the *same* file elsewhere and it's `AUTHENTIC`; modify one byte and
   re-verify — `TAMPERED`, with the stored vs. current hash shown side by
   side.
6. **API / x402** — issue an API key, call the paid verification endpoint
   past its quota, see a real `402 Payment Required`, pay the shown address
   on Algorand Testnet, retry with `X-PAYMENT: <txid>` — the backend
   verifies that payment against the Indexer before granting access.

## Known limitations (honest, as of this build)

- **Firebase**: fully implemented against the real Admin/Client SDK
  contracts, but not yet connected to a live project — every Firestore/
  Storage/Auth call is real code, currently returning 503 until credentials
  are supplied (see Setup §5).
- **Algorand system account**: real, connected, generated for this project —
  needs a Testnet faucet funding before it can anchor.
- **x402 settlement**: real, verified directly against Algorand's Indexer —
  there is no hosted x402 facilitator, by design (see "Why x402" above).
- **`crimelens/`**: an earlier AlgoKit scaffold, never customized, not part
  of the running application. Left in place for reference only.
