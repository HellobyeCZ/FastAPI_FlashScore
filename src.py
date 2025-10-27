import azure.functions as func

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import httpx  # Replaced pycurl and io
import json

from app.config import get_settings

app = FastAPI(title="FastAPI Project", version="0.1.0")
settings = get_settings()


@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.get("/odds/{event_id}")
async def get_odds(event_id: str):  # Changed to async def
    url = settings.build_odds_url(event_id)
    headers = settings.default_headers.copy()

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers)
            response.raise_for_status()  # Raises an exception for 4XX/5XX responses
            response_json = response.json()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"HTTP error from external API: {e}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=500, detail=f"Request error to external API: {e}")
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=500, detail=f"JSON decode error from external API: {e}")

    return JSONResponse(content=response_json)

# You can include routers here
# from app.routers import items_router
# app.include_router(items_router.router, prefix="/items", tags=["items"])

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
