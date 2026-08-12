"""Edge ingestion agent: watches a local folder (nearest-to-camera drop point)
and POSTs each new file to /evidence/ingest as soon as it appears, so hashing
happens as close to capture time as possible -- per design doc Sec 1.

Usage:
    python edge_agent.py --watch-dir ./incoming --case-id CASE-2026-00417 \
        --camera-id CAM-NORTHGATE-04 --api-base http://localhost:8000 \
        --token <officer JWT>
"""

import argparse
import time
from pathlib import Path

import requests

POLL_INTERVAL_SECONDS = 3


def ingest_file(api_base: str, token: str, case_id: str, camera_id: str, file_path: Path):
    with open(file_path, "rb") as f:
        files = {"file": (file_path.name, f, "application/octet-stream")}
        data = {"case_id": case_id, "camera_id": camera_id}
        resp = requests.post(
            f"{api_base}/evidence/ingest",
            data=data,
            files=files,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    resp.raise_for_status()
    return resp.json()


def watch(watch_dir: Path, api_base: str, token: str, case_id: str, camera_id: str):
    watch_dir.mkdir(parents=True, exist_ok=True)
    processed_dir = watch_dir / "_ingested"
    processed_dir.mkdir(exist_ok=True)

    print(f"Watching {watch_dir} for new evidence files...")
    while True:
        for file_path in sorted(watch_dir.iterdir()):
            if file_path.is_dir() or file_path.name.startswith("."):
                continue
            try:
                result = ingest_file(api_base, token, case_id, camera_id, file_path)
                print(f"Ingested {file_path.name} -> evidence_id={result['evidence_id']}")
                file_path.rename(processed_dir / file_path.name)
            except Exception as exc:
                print(f"Failed to ingest {file_path.name}: {exc}")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch-dir", type=Path, default=Path("./incoming"))
    parser.add_argument("--api-base", default="http://localhost:8000")
    parser.add_argument("--token", required=True, help="Officer JWT from /auth/login")
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--camera-id", required=True)
    args = parser.parse_args()

    watch(args.watch_dir, args.api_base, args.token, args.case_id, args.camera_id)
