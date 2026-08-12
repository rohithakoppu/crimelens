"""Person/object detection via YOLOv8n (Ultralytics), pretrained on COCO.

Design doc Sec 3 scopes this as MVP using the nano model for laptop/free-GPU
speed. `ultralytics` and its weights (~6MB, auto-downloaded on first use) are
an optional dependency -- if it isn't installed, detection degrades to a
clearly-labeled stub so the rest of the pipeline (tamper checks, custody,
chain anchoring) still runs end-to-end without requiring an internet-connected
model download during the hackathon demo.
"""

from functools import lru_cache

import numpy as np

_YOLO_AVAILABLE = True
try:
    from ultralytics import YOLO
except ImportError:
    _YOLO_AVAILABLE = False


@lru_cache
def _get_model():
    if not _YOLO_AVAILABLE:
        return None
    return YOLO("yolov8n.pt")


def detect_objects(image_bytes: bytes) -> dict:
    model = _get_model()
    if model is None:
        return {
            "engine": "stub",
            "note": "ultralytics not installed -- run `pip install ultralytics` to enable real YOLOv8n detection",
            "detections": [],
        }

    import cv2

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    results = model.predict(frame, verbose=False)

    detections = []
    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            detections.append(
                {
                    "label": model.names[cls_id],
                    "confidence": round(float(box.conf[0]), 4),
                    "bbox": [round(float(x), 2) for x in box.xyxy[0].tolist()],
                }
            )

    return {"engine": "yolov8n", "detections": detections}


WEAPON_LABELS = {"knife", "gun", "pistol", "rifle", "weapon"}


def flag_weapon_alerts(detection_result: dict) -> dict:
    """Best-effort investigator alert only -- never treated as autonomous
    evidence per the design doc's explicit disclaimer (Sec 3, Sec 13)."""
    alerts = [d for d in detection_result.get("detections", []) if d["label"].lower() in WEAPON_LABELS]
    return {
        "weapon_alerts": alerts,
        "disclaimer": (
            "Best-effort investigator alert only. Not court-grade evidence. "
            "Requires human review before any action is taken."
        ),
    }
