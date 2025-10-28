# FastAPI FlashScore API

This project exposes FlashScore odds data through a FastAPI application that can run as an Azure Functions HTTP-triggered endpoint or as a standalone ASGI service. The repository contains everything you need to develop locally, configure environment variables, and deploy to Azure.

## Setup

1. **Create a virtual environment:**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows use `venv\Scripts\activate`
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

## Running the application

### Azure Functions Core Tools (recommended)
The project is configured as an Azure Functions app via `function_app.py`. When developing or debugging, use Azure Functions Core Tools to emulate the Functions runtime locally:

```bash
func start
```

The local Functions host will proxy requests to the FastAPI application defined in `src.py`. By default the HTTP trigger listens on `http://localhost:7071`.

### Direct FastAPI server (for quick iteration)
For lightweight testing of the FastAPI app without the Functions host, run `uvicorn` directly against the ASGI application instance:

```bash
uvicorn src:app --reload
```

This command serves the API on `http://localhost:8000` with hot-reload enabled.

## Environment configuration

The odds integration depends on several environment variables so that requests can be tuned without editing code. Configure the following keys before running locally or deploying to Azure:

| Variable | Description | Example |
| --- | --- | --- |
| `ODDS_API_BASE_URL` | Base URL for the FlashScore odds endpoint. | `https://global.ds.lsapp.eu/odds/pq_graphql` |
| `ODDS_API_HEADERS` | JSON string containing additional HTTP headers forwarded to the upstream API. | `{"Accept": "*/*", "User-Agent": "Mozilla/5.0"}` |
| `ODDS_API_TIMEOUT_SECONDS` | Timeout (seconds) for outbound HTTP requests. | `10` |
| `ODDS_API_PROJECT_ID` | Optional project identifier appended to requests. | `1` |
| `ODDS_API_GEO_CODE` | Optional GEO/IP code values (e.g., `CZ`, `CZ10`). | `CZ` |

### Local development

1. Create a `local.settings.json` file (excluded from source control) with the `Values` section populated:
   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "python",
       "ODDS_API_BASE_URL": "https://global.ds.lsapp.eu/odds/pq_graphql",
       "ODDS_API_HEADERS": "{\"Accept\": \"*/*\", \"User-Agent\": \"Mozilla/5.0\"}",
       "ODDS_API_TIMEOUT_SECONDS": "10"
     }
   }
   ```
2. When running with `uvicorn`, you can alternatively export variables in your shell (`export ODDS_API_BASE_URL=...`) or store them in a `.env` file and load via a tool such as [`python-dotenv`](https://pypi.org/project/python-dotenv/).

### Azure deployment

In the Azure portal or via the Azure CLI, add each variable as an **Application Setting** on your Function App. Azure Functions automatically maps application settings to environment variables at runtime:

```bash
az functionapp config appsettings set \
  --name <function-app-name> \
  --resource-group <resource-group> \
  --settings ODDS_API_BASE_URL=https://global.ds.lsapp.eu/odds/pq_graphql \
             ODDS_API_TIMEOUT_SECONDS=10
```

For complex header payloads, consider storing `ODDS_API_HEADERS` as a base64-encoded JSON string or move sensitive values to Azure Key Vault and reference them with `@Microsoft.KeyVault(...)` syntax in application settings.

## Deployment workflows

### Publish from Azure Functions Core Tools

1. Sign in to Azure: `az login`.
2. Ensure you have a Function App provisioned (`az functionapp create ...`).
3. Deploy the code from your local workspace:
   ```bash
   func azure functionapp publish <function-app-name>
   ```
4. Monitor deployment output for packaging or dependency warnings.

### Continuous deployment (CI/CD)

For automated deployments, configure a pipeline (e.g., GitHub Actions, Azure Pipelines) that:

1. Installs Python and Azure Functions Core Tools.
2. Restores dependencies (`pip install -r requirements.txt`).
3. Runs tests and static analysis.
4. Packages the Function app and deploys using `func azure functionapp publish` or the `azure/functions-action` GitHub Action.

A minimal GitHub Actions workflow might include:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Install dependencies
        run: pip install -r requirements.txt
      - name: Publish to Azure Functions
        uses: Azure/functions-action@v1
        with:
          app-name: ${{ secrets.AZURE_FUNCTIONAPP_NAME }}
          publish-profile: ${{ secrets.AZURE_FUNCTIONAPP_PUBLISH_PROFILE }}
```

## Troubleshooting Azure runtime issues

- **`ModuleNotFoundError` during startup**: Ensure all dependencies are listed in `requirements.txt` and were installed during deployment. For Linux Consumption plans, avoid platform-specific wheels.
- **Environment variables missing at runtime**: Verify application settings in the Azure portal. Remember to restart the Function App after updating settings.
- **Timeouts or `HTTP 500` from upstream odds API**: Increase `ODDS_API_TIMEOUT_SECONDS`, double-check base URL and headers, and ensure the Function App has outbound network access (consider VNET integration or firewall rules if required).
- **Cold start latency**: Consumption plans experience cold starts. Consider enabling the Premium plan or a warmup trigger if low-latency responses are critical.
- **`[host] Error indexing method` logs**: Usually indicates a mismatch between the Functions runtime version and your Python version. Confirm `FUNCTIONS_WORKER_RUNTIME=python` and that you are targeting a supported Python version (3.11 or earlier depending on your runtime stack).

With these steps and references, you can confidently develop, configure, and operate the FastAPI FlashScore API both locally and in Azure.
