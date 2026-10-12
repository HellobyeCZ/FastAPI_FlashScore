.PHONY: mlflow

# Local MLflow tracking server + model registry on :5050 (macOS AirPlay
# Receiver owns :5000). Backend store: SQLite at mlflow/mlflow.db.
# Artifacts are proxied by the server (--serve-artifacts) and stored under
# mlflow/artifacts/, so clients never write to the server's disk directly.
#
# Runs through uvx in an isolated environment: the system interpreter has a
# broken mlflow install, and the server shouldn't share the app's venv.
mlflow:
	mkdir -p mlflow/artifacts
	uvx --from "mlflow>=3,<4" mlflow server \
	  --backend-store-uri sqlite:///mlflow/mlflow.db \
	  --artifacts-destination ./mlflow/artifacts \
	  --serve-artifacts \
	  --host 127.0.0.1 --port 5050
