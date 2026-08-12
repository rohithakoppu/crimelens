from fastapi import APIRouter, Depends, HTTPException

from api.deps import get_current_user
from db import repository as repo
from firebase.client import FirebaseUnavailableError

router = APIRouter(prefix="/incidents", tags=["incidents"])


@router.get("")
def list_incidents(case_id: str | None = None, _: dict = Depends(get_current_user)):
    try:
        return repo.list_incidents(case_id)
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
