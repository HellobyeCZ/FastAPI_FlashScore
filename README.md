# FastAPI Project

This is a FastAPI project.

## Setup

1.  **Create a virtual environment:**
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows use `venv\Scripts\activate`
    ```

2.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

## Running the application

```bash
uvicorn main:app --reload
```

Or, if you want to run it directly using the `if __name__ == "__main__":` block in `main.py`:
```bash
python main.py
```

The application will be available at `http://localhost:8000`.
