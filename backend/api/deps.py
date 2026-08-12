from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from db import repository as repo
from firebase.client import FirebaseUnavailableError, get_firebase_client

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)) -> dict:
    """Verifies a real Firebase ID token (issued by Firebase Auth after a
    genuine email/password sign-in) and loads the user's role/profile from
    Firestore. Returns a dict, not an ORM object, since there's no ORM
    anymore -- callers read user["id"], user["role"], user["name"]."""
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing credentials")

    try:
        decoded = get_firebase_client().verify_id_token(credentials.credentials)
    except FirebaseUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    uid = decoded["uid"]
    profile = repo.get_user(uid)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User profile not found in Firestore")
    return profile


def require_roles(*roles: str):
    def _checker(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
        return user

    return _checker
