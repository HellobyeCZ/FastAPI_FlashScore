"""FastAPI routers split out of src.py.

Each module owns one area and is included exactly once in src.py:
- ops:       GET /ops/status (shell health / pipeline freshness)
- mlflow:    /mlflow/* tracking + registry surface, POST /ml/reload
- events:    GET /events/{event_id}[...] stored-data-only match detail
- backtests: backtest run actions added after the PR #13 split (cancel)
"""
