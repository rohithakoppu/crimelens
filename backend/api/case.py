from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException

from ai.summarizer import summarize_case
from api.deps import get_current_user, require_roles
from custody import chain as custody
from db import repository as repo

router = APIRouter(prefix="/case", tags=["case"])


class CaseCreate(BaseModel):
    case_id: str
    title: str


@router.post("")
def create_case(payload: CaseCreate, user: dict = Depends(require_roles("admin", "investigator"))):
    if repo.get_case(payload.case_id) is not None:
        raise HTTPException(status_code=409, detail="Case ID already exists")
    return repo.create_case(payload.case_id, payload.title, user["id"])


@router.get("")
def list_cases(_: dict = Depends(get_current_user)):
    cases = repo.list_cases()
    out = []
    for c in cases:
        count = len(repo.list_evidence_for_case(c["case_id"]))
        out.append({**c, "evidence_count": count})
    return out


def _build_event_list(case_id: str) -> list[dict]:
    evidence_items = repo.list_evidence_for_case(case_id)
    events = []

    for ev in evidence_items:
        eid = ev["evidence_id"]
        captured = ev.get("captured_at") or ev.get("ingested_at")
        events.append({
            "type": "capture", "evidence_id": eid, "camera_id": ev.get("camera_id"),
            "timestamp": str(captured),
        })

        for r in repo.list_ai_results(eid):
            if r["result_type"] in ("tamper", "detection"):
                events.append({
                    "type": r["result_type"], "evidence_id": eid, "result": r["result_json"],
                    "timestamp": str(r["created_at"]),
                })

        for c in custody.list_events(eid):
            events.append({
                "type": "custody", "evidence_id": eid, "actor": c.get("actor_name"),
                "action": c["event_type"], "timestamp": str(c["occurred_at"]),
            })

    return sorted(events, key=lambda e: e["timestamp"])


@router.get("/{case_id}/timeline")
def get_timeline(case_id: str, _: dict = Depends(get_current_user)):
    if repo.get_case(case_id) is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return {"case_id": case_id, "events": _build_event_list(case_id)}


@router.get("/{case_id}/summary")
def get_case_summary(case_id: str, _: dict = Depends(get_current_user)):
    if repo.get_case(case_id) is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return summarize_case(_build_event_list(case_id))
