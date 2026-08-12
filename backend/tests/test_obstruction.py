"""Real OpenCV obstruction detection -- no hardcoded confidence values.
Run: pytest tests/test_obstruction.py -v
"""
import cv2
import numpy as np

from ai.camera_state import _STATES, get_state, process_frame
from ai.obstruction import analyze_frame
from config import get_settings


def _jpeg(frame: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", frame)
    assert ok
    return buf.tobytes()


def _sharp_bright_frame() -> bytes:
    frame = np.zeros((240, 240), dtype=np.uint8)
    frame[::8, :] = 255
    frame[:, ::8] = 255
    return _jpeg(frame)


def _covered_frame() -> bytes:
    return _jpeg(np.full((240, 240), 3, dtype=np.uint8))


# ---------------------------------------------------- single-frame analysis

def test_normal_frame_not_flagged():
    result = analyze_frame(_sharp_bright_frame())
    assert result["obstructed_frame"] is False
    assert result["confidence"] == 0.0


def test_covered_frame_flagged_with_nonzero_confidence():
    result = analyze_frame(_covered_frame())
    assert result["obstructed_frame"] is True
    assert result["confidence"] > 0.0


def _noisy_frame_at_brightness(mean: int) -> bytes:
    """A perfectly flat frame always has zero Laplacian variance regardless
    of brightness, which saturates the blur signal and hides brightness
    differences -- add mild texture so brightness can still differentiate
    two obstructed frames, like a real hand/cloth over a lens would."""
    rng = np.random.default_rng(42)
    noise = rng.integers(-3, 4, size=(240, 240))
    frame = np.clip(mean + noise, 0, 255).astype(np.uint8)
    return _jpeg(frame)


def test_darker_frame_yields_higher_confidence_than_dimmer_frame():
    """Confidence must scale with how far below threshold brightness is --
    proof it's computed, not a constant."""
    dim = analyze_frame(_noisy_frame_at_brightness(25))   # just under threshold(30)
    dark = analyze_frame(_noisy_frame_at_brightness(2))   # far under threshold
    assert dim["obstructed_frame"] is True
    assert dark["obstructed_frame"] is True
    assert dark["confidence"] > dim["confidence"]


def test_uniform_flat_frame_saturates_blur_confidence_regardless_of_brightness():
    """Documents the real, intentional edge case: a perfectly flat frame
    (zero texture) has zero Laplacian variance no matter how bright it is,
    so the blur signal alone already reports maximum confidence."""
    dim = analyze_frame(_jpeg(np.full((240, 240), 25, dtype=np.uint8)))
    dark = analyze_frame(_jpeg(np.full((240, 240), 2, dtype=np.uint8)))
    assert dim["obstructed_frame"] is True
    assert dark["obstructed_frame"] is True
    assert dim["confidence"] == 100.0
    assert dark["confidence"] == 100.0


# --------------------------------------------------------- state machine --

def test_normal_camera_state_is_active_with_zero_counters():
    camera_id = "CAM-PYTEST-INITIAL"
    _STATES.pop(camera_id, None)
    state = get_state(camera_id)
    assert state["status"] == "ACTIVE"
    assert state["consecutive_obstructed"] == 0
    assert state["active_event_id"] is None


def test_state_machine_requires_consecutive_frames_before_declaring_incident():
    camera_id = "CAM-PYTEST-THRESHOLD"
    _STATES.pop(camera_id, None)
    required = get_settings().consecutive_frames_required

    last = None
    for i in range(required - 1):
        last = process_frame(camera_id, _covered_frame())
        assert last["status"] == "ACTIVE", f"must not flip to OBSTRUCTED before {required} consecutive frames"
        assert last["event"] is None

    last = process_frame(camera_id, _covered_frame())
    assert last["status"] == "OBSTRUCTED"
    assert last["event"] is not None
    assert last["event"]["type"] == "OBSTRUCTION_DETECTED"
    assert last["event"]["confidence"] > 0


def test_incident_is_not_re_announced_every_frame_while_still_obstructed():
    camera_id = "CAM-PYTEST-DEDUP"
    _STATES.pop(camera_id, None)
    required = get_settings().consecutive_frames_required

    events = [process_frame(camera_id, _covered_frame())["event"] for _ in range(required + 5)]
    fired = [e for e in events if e is not None]
    assert len(fired) == 1, "OBSTRUCTION_DETECTED must fire exactly once per incident, not every frame"
    assert get_state(camera_id)["status"] == "OBSTRUCTED"


def test_state_machine_recovers_and_computes_real_downtime():
    camera_id = "CAM-PYTEST-RECOVER"
    _STATES.pop(camera_id, None)
    required = get_settings().consecutive_frames_required

    for _ in range(required):
        process_frame(camera_id, _covered_frame())
    assert get_state(camera_id)["status"] == "OBSTRUCTED"

    result = None
    for _ in range(required):
        result = process_frame(camera_id, _sharp_bright_frame())

    assert result["status"] == "ACTIVE"
    assert result["event"] is not None
    assert result["event"]["type"] == "CAMERA_RECOVERED"
    assert result["event"]["downtime_seconds"] is not None
    assert result["event"]["downtime_seconds"] >= 0


def test_clear_frames_reset_obstruction_counter_before_threshold():
    """A single clear frame before reaching the threshold must not carry
    over stale obstructed-frame progress into a later run."""
    camera_id = "CAM-PYTEST-RESET"
    _STATES.pop(camera_id, None)
    required = get_settings().consecutive_frames_required

    for _ in range(required - 1):
        process_frame(camera_id, _covered_frame())
    assert get_state(camera_id)["status"] == "ACTIVE"

    process_frame(camera_id, _sharp_bright_frame())  # resets consecutive_obstructed to 0
    assert get_state(camera_id)["consecutive_obstructed"] == 0

    last = None
    for _ in range(required - 1):
        last = process_frame(camera_id, _covered_frame())
    assert last["status"] == "ACTIVE", "must still need the full threshold again after a reset"


def test_state_still_flips_to_obstructed_even_if_firestore_persistence_fails(monkeypatch):
    """Regression test for the bug found during manual testing: when
    Firestore is unreachable, create_camera_event() raises
    FirebaseUnavailableError. The live operator-facing status must still
    flip to OBSTRUCTED (a real attack must never be silently missed just
    because the database write failed), it just carries persist_error and
    no event_id. Same for recovery."""
    from firebase.client import FirebaseUnavailableError
    from db import repository as repo

    def _boom(*args, **kwargs):
        raise FirebaseUnavailableError("Firebase not configured (simulated for test)")

    monkeypatch.setattr(repo, "create_camera_event", _boom)
    monkeypatch.setattr(repo, "close_camera_event", _boom)

    camera_id = "CAM-PYTEST-NO-FIRESTORE"
    _STATES.pop(camera_id, None)
    required = get_settings().consecutive_frames_required

    result = None
    for _ in range(required):
        result = process_frame(camera_id, _covered_frame())

    assert result["status"] == "OBSTRUCTED", "must reflect real detection even when persistence fails"
    assert result["event"]["type"] == "OBSTRUCTION_DETECTED"
    assert result["event"]["event_id"] is None
    assert "persist_error" in result["event"]

    # And it must not spam the event on every subsequent frame while still down.
    again = process_frame(camera_id, _covered_frame())
    assert again["event"] is None
    assert again["status"] == "OBSTRUCTED"

    # Recovery must also work despite no persisted event_id to close.
    recovered = None
    for _ in range(required):
        recovered = process_frame(camera_id, _sharp_bright_frame())
    assert recovered["status"] == "ACTIVE"
    assert recovered["event"]["type"] == "CAMERA_RECOVERED"
    assert recovered["event"]["downtime_seconds"] is not None
    assert "persist_error" in recovered["event"]
