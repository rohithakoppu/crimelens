"""Per-camera obstruction state machine: turns single-frame analysis into a
real, timestamped OBSTRUCTION_DETECTED / CAMERA_RECOVERED incident lifecycle,
requiring CONSECUTIVE_FRAMES_REQUIRED consecutive flagged (or clear) frames
before flipping state, to avoid false positives on a single bad frame.

State lives in-process (per camera_id) -- correct for a single backend
instance, which is what this hackathon prototype runs. Incidents are
persisted to Firestore via db.repository as soon as they open/close, so the
event history survives a backend restart even though the in-flight
consecutive-frame counters don't. Local `active` state is intentionally
independent of whether that Firestore write succeeded: if Firestore is
unreachable, the live status shown to the operator must still flip to
OBSTRUCTED (otherwise a real attack goes unreported), it just won't have a
persisted event_id -- and the incident is not re-announced every frame while
still open.
"""
import time
from dataclasses import dataclass, field

from ai.obstruction import analyze_frame
from config import get_settings
from db import repository as repo
from firebase.client import FirebaseUnavailableError


@dataclass
class CameraState:
    consecutive_obstructed: int = 0
    consecutive_clear: int = 0
    active: bool = False
    active_event_id: str | None = None
    active_event_started: float | None = None
    active_incident_id: str | None = None
    confidence_samples: list = field(default_factory=list)
    last_analysis: dict | None = None
    case_id: str | None = None


_STATES: dict[str, CameraState] = {}


def _state_for(camera_id: str) -> CameraState:
    return _STATES.setdefault(camera_id, CameraState())


def get_state(camera_id: str) -> dict:
    s = _state_for(camera_id)
    return {
        "camera_id": camera_id,
        "status": "OBSTRUCTED" if s.active else "ACTIVE",
        "consecutive_obstructed": s.consecutive_obstructed,
        "consecutive_clear": s.consecutive_clear,
        "active_event_id": s.active_event_id,
        "active_incident_id": s.active_incident_id,
        "last_analysis": s.last_analysis,
    }


def _severity_for(confidence: float) -> str:
    if confidence >= 80:
        return "HIGH"
    if confidence >= 40:
        return "MEDIUM"
    return "LOW"


def process_frame(camera_id: str, image_bytes: bytes, case_id: str | None = None) -> dict:
    settings = get_settings()
    analysis = analyze_frame(image_bytes)
    state = _state_for(camera_id)
    state.last_analysis = analysis
    if case_id:
        state.case_id = case_id

    event = None

    if analysis["obstructed_frame"]:
        state.consecutive_obstructed += 1
        state.consecutive_clear = 0
        state.confidence_samples.append(analysis["confidence"])

        if state.consecutive_obstructed >= settings.consecutive_frames_required and not state.active:
            window = state.confidence_samples[-settings.consecutive_frames_required:]
            avg_confidence = round(sum(window) / len(window), 1)
            state.active = True
            state.active_event_started = time.time()
            event_metadata = {"brightness": analysis["brightness"], "laplacian_variance": analysis["laplacian_variance"]}
            try:
                created = repo.create_camera_event(camera_id, "OBSTRUCTION_DETECTED", avg_confidence, event_metadata)
                state.active_event_id = created["id"]
                event = {"type": "OBSTRUCTION_DETECTED", "confidence": avg_confidence, "event_id": created["id"]}
            except FirebaseUnavailableError as exc:
                state.active_event_id = None
                event = {"type": "OBSTRUCTION_DETECTED", "confidence": avg_confidence, "event_id": None,
                         "persist_error": str(exc)}

            # A real incident record is a separate concern from the raw
            # camera event: it's what the Incidents page and the case
            # timeline read from, and it carries a severity derived from the
            # actual confidence score, not a hardcoded value.
            try:
                incident = repo.create_incident(
                    camera_id=camera_id, case_id=state.case_id, incident_type="CAMERA_OBSTRUCTION",
                    severity=_severity_for(avg_confidence), camera_event_id=state.active_event_id,
                    metadata={**event_metadata, "confidence": avg_confidence},
                )
                state.active_incident_id = incident["id"]
            except FirebaseUnavailableError:
                state.active_incident_id = None
    else:
        state.consecutive_clear += 1
        state.consecutive_obstructed = 0
        state.confidence_samples = []

        if state.active and state.consecutive_clear >= settings.consecutive_frames_required:
            downtime = round(time.time() - state.active_event_started, 1) if state.active_event_started else None
            if state.active_event_id is not None:
                try:
                    repo.close_camera_event(state.active_event_id, downtime)
                    event = {"type": "CAMERA_RECOVERED", "downtime_seconds": downtime, "event_id": state.active_event_id}
                except FirebaseUnavailableError as exc:
                    event = {"type": "CAMERA_RECOVERED", "downtime_seconds": downtime,
                              "event_id": state.active_event_id, "persist_error": str(exc)}
            else:
                event = {"type": "CAMERA_RECOVERED", "downtime_seconds": downtime, "event_id": None,
                          "persist_error": "Original OBSTRUCTION_DETECTED event was never persisted"}
            if state.active_incident_id is not None:
                try:
                    repo.resolve_incident(state.active_incident_id, {"downtime_seconds": downtime})
                except FirebaseUnavailableError:
                    pass
            state.active = False
            state.active_event_id = None
            state.active_event_started = None
            state.active_incident_id = None

    result = get_state(camera_id)
    result["event"] = event
    return result
