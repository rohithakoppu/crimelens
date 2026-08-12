from fastapi import APIRouter, Depends

from api.deps import require_roles
from db import repository as repo

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/roles")
def list_roles(_: dict = Depends(require_roles("admin"))):
    return [
        {"id": u["id"], "name": u["name"], "email": u["email"], "role": u["role"], "mfa_enabled": u.get("mfa_enabled", False)}
        for u in repo.list_users()
    ]
