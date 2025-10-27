# FastAPI Project

This project exposes a small FastAPI application for retrieving FlashScore odds data.

## Setup

1. **Create a virtual environment:**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows use `venv\\Scripts\\activate`
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure environment variables:**
   Copy one of the example environment files and adjust the values as needed.
   ```bash
   cp .env.local.example .env  # or .env.staging.example
   ```

## Configuration

Settings are loaded via [`pydantic-settings`](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) from environment variables or a local `.env` file. All variables are optional; the defaults shown below will be used when no value is provided.

| Environment variable | Description | Default |
| -------------------- | ----------- | ------- |
| `APP_ODDS_ENDPOINT_BASE` | Base URL for the FlashScore odds endpoint. | `https://global.ds.lsapp.eu/odds/pq_graphql` |
| `APP_ODDS_HASH` | Hash query parameter required by the odds endpoint. | `oce` |
| `APP_PROJECT_ID` | Project identifier used when requesting odds data. | `1` |
| `APP_GEO_IP_CODE` | Geo IP country code parameter for the odds endpoint. | `CZ` |
| `APP_GEO_IP_SUBDIVISION_CODE` | Geo IP subdivision code parameter for the odds endpoint. | `CZ10` |
| `APP_DEFAULT_HEADERS` | JSON object defining the headers sent to the odds endpoint. | See `app/config.py` |

To override the default headers, provide a valid JSON object. For example:
```env
APP_DEFAULT_HEADERS={"Accept": "*/*", "User-Agent": "my-custom-agent"}
```

## Running the application

Use Uvicorn to run the FastAPI app defined in `src.py`:

```bash
uvicorn src:app --reload
```

Or, run the module directly using the `if __name__ == "__main__"` block:
```bash
python src.py
```

The application will be available at `http://localhost:8000`.
