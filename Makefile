.PHONY: mlflow

# Local MLflow tracking server for Phase A. Backend: SQLite at
# mlflow/mlflow.db. Artifacts: mlflow/artifacts/. UI: http://127.0.0.1:5000.
mlflow:
	mkdir -p mlflow/artifacts
	mlflow server \
	  --backend-store-uri sqlite:///mlflow/mlflow.db \
	  --default-artifact-root ./mlflow/artifacts \
	  --host 127.0.0.1 --port 5000
