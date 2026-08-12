"""Classical-CV tamper detection: blur, blackout, and camera rotation/angle-shift.

Per the design doc Sec 3: classical CV alone catches most cases with zero
training data, and is deterministic/explainable -- a judge trusts "keypoint
drift exceeded threshold X" more than an opaque ML score. A CNN fallback is
noted as the production path but intentionally not required for the MVP.
"""

import cv2
import numpy as np

BLUR_VARIANCE_THRESHOLD = 100.0  # below this, Laplacian variance suggests heavy blur
BLACKOUT_MEAN_THRESHOLD = 15.0  # below this mean pixel intensity, the frame looks blacked out
ROTATION_DRIFT_THRESHOLD = 0.35  # fraction of keypoint matches lost vs reference frame


def _read_frame(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if frame is None:
        raise ValueError("Could not decode image bytes as a frame")
    return frame


def detect_blur(image_bytes: bytes) -> dict:
    frame = _read_frame(image_bytes)
    variance = float(cv2.Laplacian(frame, cv2.CV_64F).var())
    return {
        "check": "blur",
        "laplacian_variance": variance,
        "threshold": BLUR_VARIANCE_THRESHOLD,
        "flagged": variance < BLUR_VARIANCE_THRESHOLD,
    }


def detect_blackout(image_bytes: bytes) -> dict:
    frame = _read_frame(image_bytes)
    mean_intensity = float(np.mean(frame))
    return {
        "check": "blackout",
        "mean_intensity": mean_intensity,
        "threshold": BLACKOUT_MEAN_THRESHOLD,
        "flagged": mean_intensity < BLACKOUT_MEAN_THRESHOLD,
    }


def detect_rotation_drift(image_bytes: bytes, reference_bytes: bytes) -> dict:
    """ORB keypoint matching against a reference frame; large homography /
    match-ratio drift suggests the camera has been physically moved."""
    frame = _read_frame(image_bytes)
    reference = _read_frame(reference_bytes)

    orb = cv2.ORB_create(nfeatures=500)
    kp1, des1 = orb.detectAndCompute(reference, None)
    kp2, des2 = orb.detectAndCompute(frame, None)

    if des1 is None or des2 is None or len(kp1) == 0 or len(kp2) == 0:
        return {"check": "rotation", "match_ratio": 0.0, "flagged": True, "reason": "no keypoints detected"}

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(des1, des2)
    match_ratio = len(matches) / max(len(kp1), 1)
    drift = 1.0 - match_ratio

    return {
        "check": "rotation",
        "match_ratio": round(match_ratio, 4),
        "drift": round(drift, 4),
        "threshold": ROTATION_DRIFT_THRESHOLD,
        "flagged": drift > ROTATION_DRIFT_THRESHOLD,
    }


def run_tamper_checks(image_bytes: bytes, reference_bytes: bytes | None = None) -> dict:
    results = {
        "blur": detect_blur(image_bytes),
        "blackout": detect_blackout(image_bytes),
    }
    if reference_bytes is not None:
        results["rotation"] = detect_rotation_drift(image_bytes, reference_bytes)

    any_flagged = any(r.get("flagged") for r in results.values())
    return {"checks": results, "tamper_suspected": any_flagged}
