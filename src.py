from functools import lru_cache
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from app.schemas.errors import APIErrorResponse
from app.services.odds_client import OddsAPIError, OddsClient, build_odds_client

app = FastAPI(title="FastAPI Project", version="0.1.0")


@lru_cache()
def _get_odds_client() -> OddsClient:
    return build_odds_client()


def odds_client_dependency() -> OddsClient:
    return _get_odds_client()


@app.on_event("shutdown")
async def shutdown_odds_client() -> None:
    await _get_odds_client().aclose()


@app.exception_handler(OddsAPIError)
async def odds_error_handler(_: Request, exc: OddsAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Hello World"}


@app.get(
    "/odds/{event_id}",
    responses={
        429: {"model": APIErrorResponse, "description": "Rate limited by upstream provider."},
        502: {"model": APIErrorResponse, "description": "Upstream service produced an error."},
        503: {"model": APIErrorResponse, "description": "Upstream service unavailable."},
        504: {"model": APIErrorResponse, "description": "Upstream timeout or connectivity issue."},
    },
)
async def get_odds(event_id: str, client: OddsClient = Depends(odds_client_dependency)) -> JSONResponse:
    data: Any = await client.get_odds(event_id)
    return JSONResponse(content=data)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
