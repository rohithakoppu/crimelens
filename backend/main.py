from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api import admin, assistant, auth, camera, case, evidence, incidents, x402
from blockchain.algorand.client import AlgorandUnavailableError, get_algorand_client
from config import get_settings
from firebase.client import FirebaseUnavailableError, get_firebase_client
from storage.object_store import ObjectStoreUnavailableError

settings = get_settings()

app = FastAPI(title=settings.app_name, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Any endpoint that forgets to locally catch an *Unavailable error (or a new
# one we add later) must still fail as an honest 503 with CORS headers
# intact -- not a bare 500 that the browser can't even read due to a missing
# Access-Control-Allow-Origin header on Starlette's raw error path.
@app.exception_handler(FirebaseUnavailableError)
async def firebase_unavailable_handler(request: Request, exc: FirebaseUnavailableError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(AlgorandUnavailableError)
async def algorand_unavailable_handler(request: Request, exc: AlgorandUnavailableError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(ObjectStoreUnavailableError)
async def storage_unavailable_handler(request: Request, exc: ObjectStoreUnavailableError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/health")
def health():
    """Real health checks -- each service is actually probed, never
    hardcoded to ONLINE."""
    firebase_status = get_firebase_client().status()
    algorand_status = get_algorand_client().status()
    app_id = settings.algorand_app_id.strip()
    return {
        "status": "ok",
        "app": settings.app_name,
        "services": {
            "firebase": {"status": "ONLINE" if firebase_status["configured"] else "UNAVAILABLE", **firebase_status},
            "algorand": {"status": "ONLINE" if algorand_status["connected"] else "UNAVAILABLE", **algorand_status},
            "smart_contract": {
                "status": "DEPLOYED" if app_id else "NOT_CONFIGURED",
                "app_id": int(app_id) if app_id.isdigit() else None,
                "network": settings.algorand_network,
            },
        },
    }


app.include_router(auth.router)
app.include_router(evidence.router)
app.include_router(case.router)
app.include_router(camera.router)
app.include_router(incidents.router)
app.include_router(assistant.router)
app.include_router(admin.router)
app.include_router(x402.router)
