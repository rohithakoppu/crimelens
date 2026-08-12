"""Single-frame obstruction analysis: brightness + Laplacian (blur) variance.

A covered/blacked-out lens reads as low mean pixel intensity; a hand,
cloth, or heavy defocus over the lens reads as low Laplacian variance
(no sharp edges left to differentiate). Either signal alone can false-
positive (a dark room, a genuinely blurry pan) -- the consecutive-frame
requirement in camera_state.py is what turns this into a real incident.
"""
import cv2
import numpy as np

from config import get_settings


def _read_gray(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if frame is None:
        raise ValueError("Could not decode image bytes as a frame")
    return frame


def analyze_frame(image_bytes: bytes) -> dict:
    settings = get_settings()
    frame = _read_gray(image_bytes)

    brightness = float(np.mean(frame))
    laplacian_variance = float(cv2.Laplacian(frame, cv2.CV_64F).var())

    brightness_low = brightness < settings.obstruction_threshold_brightness
    blur_high = laplacian_variance < settings.obstruction_threshold_laplacian
    obstructed = brightness_low or blur_high

    brightness_score = (
        max(0.0, (settings.obstruction_threshold_brightness - brightness) / max(settings.obstruction_threshold_brightness, 1.0))
        if brightness_low else 0.0
    )
    blur_score = (
        max(0.0, (settings.obstruction_threshold_laplacian - laplacian_variance) / max(settings.obstruction_threshold_laplacian, 1.0))
        if blur_high else 0.0
    )
    confidence = round(min(100.0, max(brightness_score, blur_score) * 100), 1) if obstructed else 0.0

    return {
        "brightness": round(brightness, 2),
        "laplacian_variance": round(laplacian_variance, 2),
        "brightness_threshold": settings.obstruction_threshold_brightness,
        "laplacian_threshold": settings.obstruction_threshold_laplacian,
        "obstructed_frame": obstructed,
        "confidence": confidence,
    }
