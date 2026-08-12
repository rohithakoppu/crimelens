from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ai.camera_state import get_state, process_frame
from api.deps import get_current_user
from config import get_settings
from db import repository as repo
from firebase.client import FirebaseUnavailableError

router = APIRouter(prefix="/cameras", tags=["cameras"])


class CameraRegisterRequest(BaseModel):
    camera_id: str
    name: str
    source_type: str = "web"  # CameraSource discriminator: 'web' | 'rtsp' | 'onvif'
    case_id: str | None = None


@router.post("")
def register_camera(payload: CameraRegisterRequest, user: dict = Depends(get_current_user)):
    if payload.source_type not in ("web", "rtsp", "onvif"):
        raise HTTPException(status_code=400, detail="source_type must be one of: web, rtsp, onvif")
    try:
        return repo.register_camera(payload.camera_id, payload.name, payload.source_type, payload.case_id, user["id"])
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("")
def list_cameras(_: dict = Depends(get_current_user)):
    try:
        return repo.list_cameras()
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.post("/{camera_id}/frame")
async def analyze_frame(
    camera_id: str, frame: UploadFile = File(...), case_id: str | None = Form(None),
    _: dict = Depends(get_current_user),
):
    """Frontend posts one JPEG frame at ANALYSIS_FPS while Live Monitoring is
    open. Real OpenCV analysis runs synchronously and returns the current
    obstruction state; the frontend renders whatever this returns, it does
    not guess or animate a fake state on its own. `case_id`, when provided,
    links any incident this frame triggers to the active case."""
    image_bytes = await frame.read()
    return process_frame(camera_id, image_bytes, case_id=case_id)


@router.get("/{camera_id}/status")
def camera_status(camera_id: str, _: dict = Depends(get_current_user)):
    state = get_state(camera_id)
    try:
        open_event = repo.get_open_obstruction_event(camera_id)
    except FirebaseUnavailableError:
        open_event = None
    return {**state, "open_event": open_event, "analysis_fps": get_settings().analysis_fps}


@router.get("/{camera_id}/events")
def camera_events(camera_id: str, _: dict = Depends(get_current_user)):
    return repo.list_camera_events(camera_id)


@router.get("/events")
def all_camera_events(_: dict = Depends(get_current_user)):
    return repo.list_camera_events(None, limit=200)
