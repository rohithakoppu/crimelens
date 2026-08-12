from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ai.assistant import answer_question
from api.case import _build_event_list
from api.deps import get_current_user
from db import repository as repo

router = APIRouter(prefix="/case", tags=["assistant"])


class AssistantQuery(BaseModel):
    question: str


@router.post("/{case_id}/assistant/query")
def query_assistant(case_id: str, payload: AssistantQuery, _: dict = Depends(get_current_user)):
    if repo.get_case(case_id) is None:
        raise HTTPException(status_code=404, detail="Case not found")

    events = _build_event_list(case_id)
    return answer_question(payload.question, events)
