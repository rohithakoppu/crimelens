# CrimeLens

A forensic evidence integrity and verification platform. It creates a
cryptographically verifiable chain of custody from the moment a camera
captures footage to the moment anyone — including someone who doesn't trust
the platform operator — independently verifies it.

---

## QUICK START — WINDOWS

1. Install **Node.js LTS** from https://nodejs.org
2. Install **Python 3.11+** from https://www.python.org/downloads/
   (check "Add python.exe to PATH" during install)
3. Clone or download this repository anywhere on your computer — any
   drive, any folder name, any Windows account. It does not need to be a
   specific location.
4. Double-click:

   ```
   run-crimelens.bat
   ```

5. The first run installs backend/frontend dependencies automatically
   (this can take a few minutes — it only happens once). Every run after
   that starts in a few seconds.
6. Your browser opens automatically once both services are actually ready.
7. To stop everything cleanly, double-click `stop-crimelens.bat`.

**If something fails**, the launcher window stays open and tells you
exactly what failed and what to do about it — it never just closes
silently.

**About the camera**: CrimeLens's Live Camera page asks for real browser
webcam permission. Click **Allow** when prompted. This only works because
the launcher opens the app at `http://localhost:5173` — browsers block
camera access entirely on a plain `file://` page, so never open
`frontend/index.html` directly. If your computer has no webcam, or another
app is already using it, the page clearly says so instead of pretending
the camera works — use the **Prototype Video** mode instead (see below).

**About login**: the app ships with no real credentials committed to the
repository (see [Environment variables](#environment-variables) below). On
first run the launcher creates `backend/.env` and `frontend/.env` from
their example templates automatically, so the app starts either way — but
signing in requires your own free Firebase project. This is a five-minute
one-time setup; see [Setup §5](#5-firebase-project).

---

## The problem

Digital/video evidence can be modified, replaced, deleted, or have its
custody history questioned. Once a file leaves the camera, there's usually
no way to prove it's the same file that was originally captured, who's
touched it since, or whether it's been tampered with.

## The solution

Every piece of evidence goes through a real, deterministic pipeline:

```
REAL WEBCAM  (or a real pre-recorded test video, in Prototype Video mode)
    │
REAL VIDEO CAPTURE (MediaRecorder, 15s chunks)
    │
OPENCV OBSTRUCTION DETECTION (live, per-frame)
    │
EVIDENCE ID  (EVD-YYYY-XXXXXX)
    │
SHA-256 hash of each segment
    │
Hash-linked segment chain  →  Evidence Root Hash
    │
Ed25519 digital signature of the original hash
    │
AES-256-GCM encrypted local disk storage  +  Firestore (metadata)
    │
Algorand Testnet smart contract anchor (Evidence Registry, real box storage)
    │
Hash-linked chain-of-custody event log
    │
Deterministic verification (AUTHENTIC / TAMPERED / INTEGRITY_FAILURE)
    │
x402-gated API access for external systems
```

### What this honestly proves — and what it doesn't

Blockchain anchoring proves:
- the file has a specific SHA-256 hash and a specific Evidence Root Hash
- that hash was registered/anchored at a specific time, independently checkable by anyone
- the file has not changed since that hash was created
- the Ed25519 signature over the hash is valid
- custody events and segments form a tamper-evident, hash-linked chain

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
| Metadata database | **Cloud Firestore** | Flexible schema for evidence/custody/camera-event documents |
| Evidence file storage | **Local encrypted disk** (`backend/data/evidence/`, AES-256-GCM) | Never requires a paid cloud storage plan; the object store is an abstraction (`storage/object_store.py`), so a cloud backend can be swapped in later without touching anything upstream |
| Auth | **Firebase Authentication** | Real Google/email sign-in; backend never stores passwords, only verifies ID tokens |
| Blockchain | **Algorand Testnet** (`algosdk`, Algod + Indexer, a real deployed smart contract) | See below |
| Computer vision | OpenCV (obstruction, blur, blackout, rotation drift), optional YOLOv8n | Deterministic, explainable classical CV; ML only where it adds real value |
| Payments/API access | **x402-compatible HTTP 402** layer, settled via real Algorand micropayments | See below |

### Why Algorand

Evidence is anchored via a real, purpose-built **Evidence Registry** smart
contract (`backend/blockchain/algorand/contracts/evidence_registry.py`,
PyTeal), deployed with `backend/scripts/deploy_contract.py`. Each evidence
item's **Evidence Root Hash** (the hash of its entire segment chain, not
just the first chunk) is registered in the contract's box storage —
immutable, rejects duplicate registration, rejects contract
updates/deletes.

Every anchor is a **real, submitted, confirmed Testnet transaction** —
never a fabricated app ID or txid. If the system account isn't funded, the
contract isn't deployed, or the network is unreachable, evidence creation
still succeeds and `blockchain_status` honestly reports
`UNAVAILABLE`/`NOT_CONFIGURED`, completely independent of the
cryptographic integrity verdict.

Verification independently re-reads the contract's on-chain box via the
**Algorand Indexer/Algod** and compares the anchored root hash against the
one being verified — it does not just trust a cached database field.

### Why x402

Blockchain anchoring solves evidence *provenance*. x402 solves *controlled,
paid programmatic access* to the verification API — the scenario where a
forensic company or insurer wants to verify thousands of evidence records
via API rather than by hand.

`POST /api/v1/verification/verify` requires an API key (free/pro/enterprise
tier, purely for identification and hourly-quota bucketing). Once a tier's
quota is exhausted, the endpoint returns a genuine `HTTP 402 Payment
Required` with a machine-readable payment requirement. Settlement is **not
simulated**: the required payment is a real ALGO transfer to the system's
Algorand address, verified by independently looking the transaction up via
the Algorand Indexer — checking amount, receiver, and that the txid hasn't
already been redeemed — before granting access.

### Cryptography

- **SHA-256** (`hashlib`) over every segment's raw bytes and the original
  file — deterministic, any change produces a different hash.
- **Evidence Root Hash**: a deterministic hash over the entire segment
  chain (`custody/verification.py`), recomputed live on every verification
  — not a cached value trusted blindly.
- **Ed25519** (`cryptography` library) signs the original SHA-256 hash with
  a system keypair; the public key verifies it.
- **AES-256-GCM** (`cryptography.hazmat`) encrypts the file before it's
  ever written to local disk, with a random nonce per object and an
  authentication tag. The key lives only in backend config, never the
  frontend.

### Real-time camera obstruction detection

`backend/ai/obstruction.py` runs actual OpenCV analysis on each frame: mean
brightness and Laplacian variance (blur). `backend/ai/camera_state.py` is a
per-camera state machine requiring `CONSECUTIVE_FRAMES_REQUIRED` consecutive
flagged (or clear) frames before declaring an incident, to avoid false
positives from one bad frame. Confidence and downtime are both **computed
from the actual frames and timestamps**, never hardcoded.

### Chain of custody

Every meaningful action on a piece of evidence (`EVIDENCE_CREATED`,
`HASH_GENERATED`, `SIGNED`, `ENCRYPTED`, `STORED`, `SEGMENT_CREATED`,
`BLOCKCHAIN_ANCHORED`, `ACCESSED`, `VERIFICATION_REQUESTED`, etc.) appends
one event to `evidence/{id}/custody_events` in Firestore. Each event's hash
commits to its own fields **and** the previous event's hash
(`backend/custody/chain.py`). Editing, reordering, or deleting an earlier
event breaks the chain from that point forward.

### Verification engine

`GET /evidence/{id}/verify` (public, no auth) runs the full deterministic
check: recompute SHA-256 from the stored (decrypted) file, verify the
Ed25519 signature, verify the segment hash chain, recompute the Evidence
Root Hash, independently re-check the Algorand anchor, verify the custody
chain. Returns `AUTHENTIC` only if every cryptographic check passes;
blockchain availability is reported separately and never turns real
integrity into a false `TAMPERED` verdict. The same logic is reused (not
duplicated) by the paid x402 API path.

### Prototype Video mode

For demos/testing without a physical webcam: `/prototype-video` lets you
select a real pre-recorded video (or upload your own) and runs it through
the exact same production pipeline — the video plays through a hidden
element, its real decoded frames are captured via
`HTMLVideoElement.captureStream()`, and chunked with the browser's real
`MediaRecorder`, uploaded through the same `/evidence/ingest` and
`/evidence/{id}/segments` endpoints the real camera uses. Nothing about the
resulting evidence record is faked or stored separately from real evidence.

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
- File uploads go through multipart form validation with an enforced size
  ceiling; encryption keys and service-account credentials are never logged.

## Project structure

```
run-crimelens.bat    the launcher -- double-click this
stop-crimelens.bat    stops the services it started
backend/
  api/            auth, evidence, case, camera, admin, assistant, x402
  ai/             obstruction detection, tamper checks, object detection, summarizer, assistant
  blockchain/algorand/   Algod + Indexer client, the Evidence Registry contract, anchoring
  custody/        hash-linked chain-of-custody log, segment chain, verification engine
  db/             Firestore repository
  firebase/       Firebase Admin SDK bootstrap (Firestore + Auth)
  storage/        AES-256-GCM envelope encryption + local disk object store
  utils/          security helpers, PDF certificate generation
  scripts/        deploy_contract.py -- one-time smart contract deployment
  tests/          pytest suite
frontend/
  src/pages/      Landing, Login, Dashboard, LiveCamera, PrototypeEvidence,
                  CaseDetail, EvidenceDetail, VerifyPublic, Blockchain,
                  Certificates, Incidents, ApiAccess, Admin, Settings
```

## Environment variables

Real secrets are **never committed** to this repository. `run-crimelens.bat`
automatically creates `backend/.env` and `frontend/.env` from their
`.env.example` templates on first run if they don't already exist, so the
app always starts — every Firebase/Algorand-backed feature just honestly
reports `NOT CONFIGURED`/`UNAVAILABLE` until you fill in real values.

### `backend/.env`

```env
JWT_SECRET=...

# Firebase -- see Setup §5 for how to get these
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_WEB_API_KEY=
FIREBASE_SERVICE_ACCOUNT_JSON=            # paste the full JSON inline, or:
FIREBASE_SERVICE_ACCOUNT_PATH=firebase-service-account.json

# Algorand Testnet
ALGORAND_NETWORK=testnet
ALGORAND_ALGOD_SERVER=https://testnet-api.algonode.cloud
ALGORAND_INDEXER_SERVER=https://testnet-idx.algonode.cloud
SYSTEM_ALGORAND_MNEMONIC=                 # 25-word mnemonic of a FUNDED testnet account
ALGORAND_APP_ID=                          # set after deploying the contract (scripts/deploy_contract.py)

# AES-256-GCM key (64 hex chars = 32 bytes)
ENCRYPTION_KEY=

# Ed25519 keypair for evidence signing
SYSTEM_ED25519_PRIVATE_KEY_HEX=
SYSTEM_ED25519_PUBLIC_KEY_HEX=
```

See `backend/.env.example` for the complete, documented template (obstruction
detection tuning, x402 tier limits, etc.).

### `frontend/.env`

```env
VITE_API_BASE_URL=http://localhost:8000

# Firebase web config -- public identifiers, safe to ship in a frontend
# bundle by design. Firebase console -> Project settings -> General.
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
```

## Setup

The launcher (`run-crimelens.bat`) handles dependency installation and
`.env` creation automatically. The steps below are for filling in real
credentials, or for running things manually without the launcher.

### 1. Backend (manual, without the launcher)

```bash
cd backend
python -m venv venv
./venv/Scripts/activate          # Windows; `source venv/bin/activate` on Mac/Linux
pip install -r requirements.txt
```

### 2. Algorand Testnet account

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
2. **Authentication** → Sign-in method → enable **Google** and/or **Email/Password**
3. **Firestore Database** → create (test mode is fine to start)
4. Project settings → **Service accounts** → Generate new private key →
   save the JSON as `backend/firebase-service-account.json` (already
   gitignored), or paste its contents into `FIREBASE_SERVICE_ACCOUNT_JSON`
5. Project settings → General → note your **Project ID**, **Storage
   bucket**, and **Web API key** → put them in `backend/.env`
   (`FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_WEB_API_KEY`)
6. Project settings → General → your web app's config → copy `apiKey`,
   `authDomain`, `projectId`, `storageBucket` into `frontend/.env`

Until this is done, the app still starts and runs — every Firebase-backed
endpoint returns a clean `503 Firebase not configured` instead of faking
success, and `/health` reports it honestly.

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

### 7. Deploy the Evidence Registry smart contract (optional)

Requires a funded Algorand Testnet account (step 2).

```bash
cd backend
python scripts/deploy_contract.py
```

Never auto-run by the launcher — it spends real (testnet) ALGO. Put the
resulting application ID in `ALGORAND_APP_ID` in `backend/.env`.

### 8. Run it manually (without the launcher)

```bash
cd backend && ./venv/Scripts/python.exe -m uvicorn main:app --reload --port 8000
cd frontend && npm install && npm run dev
```

Optional: `pip install ultralytics` in the backend venv to enable real
YOLOv8n object detection (weights auto-download on first use). Without it,
the detection step is clearly labeled `"engine": "stub"` rather than faking
results.

## Testing

```bash
cd backend
./venv/Scripts/python.exe -m pytest -q
```

```bash
cd frontend
npm run build      # tsc -b && vite build
```

## Demo walkthrough

1. **Dashboard** — shows real Firebase/Algorand connectivity (not
   hardcoded "ONLINE"), case list.
2. **Live Camera** — click *Start Camera* (real `getUserMedia` prompt),
   *Start Monitoring* (real OpenCV frame analysis), *Start Recording* (real
   `MediaRecorder`, 15-second auto-chunked evidence uploads). Cover the
   lens: watch it flip to `OBSTRUCTION DETECTED` with a computed confidence.
   No webcam? Use **Prototype Video** instead.
3. Each recorded chunk shows its real pipeline status: hash → signature →
   encryption → storage → segment chain → root hash → Algorand anchor.
4. **Evidence Detail** — full integrity pillars, custody timeline, "Verify
   now" (recomputes everything live).
5. **Public Verify** (`/verify`, no login) — paste an evidence ID; upload
   the *same* file elsewhere and it's `AUTHENTIC`; modify one byte and
   re-verify — `TAMPERED`, with the stored vs. current hash shown side by
   side.
6. **API / x402** — issue an API key, call the paid verification endpoint
   past its quota, see a real `402 Payment Required`.

## Known limitations (honest, as of this build)

- **Firebase**: fully implemented against the real Admin/Client SDK
  contracts, but requires your own project's credentials (see Setup §5) —
  every Firestore/Auth call is real code, returning 503 honestly until
  configured.
- **Algorand system account / smart contract**: real, deployable code —
  needs a Testnet faucet-funded account before it can anchor.
- **x402 settlement**: real, verified directly against Algorand's Indexer —
  there is no hosted x402 facilitator, by design (see "Why x402" above).
