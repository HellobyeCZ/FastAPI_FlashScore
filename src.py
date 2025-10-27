from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
import httpx  # Replaced pycurl and io
import json

from app.schemas.odds import OddsResponse
from app.services.odds import map_odds_payload

app = FastAPI(title="FastAPI Project", version="0.1.0")


@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.get("/odds/{event_id}", response_model=OddsResponse)
async def get_odds(event_id: str):  # Changed to async def
    url = f'https://global.ds.lsapp.eu/odds/pq_graphql?_hash=oce&eventId={event_id}&projectId=1&geoIpCode=CZ&geoIpSubdivisionCode=CZ10'
    headers = {
        'Accept': '*/*',
        'Sec-Fetch-Site': 'cross-site',
        'Origin': 'https://www.livesport.cz',
        'Sec-Fetch-Dest': 'empty',
        'Accept-Language': 'cs-CZ,cs;q=0.9',
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.livesport.cz/',
        'Priority': 'u=3, i'
    }

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

    odds_response = map_odds_payload(event_id=event_id, payload=response_json)
    return JSONResponse(content=jsonable_encoder(odds_response))


# You can include routers here
# from app.routers import items_router
# app.include_router(items_router.router, prefix="/items", tags=["items"])

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
