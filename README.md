# FastAPI FlashScore

This repository exposes a FastAPI service that proxies FlashScore odds data and now includes a modern web dashboard for exploring markets in real time.

## Backend (FastAPI)

1. **Create a virtual environment**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows use `venv\\Scripts\\activate`
   ```
2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```
3. **Run the API locally**
   ```bash
   uvicorn src:app --reload
   ```

   The API will be available at `http://localhost:8000`.

## Frontend (Next.js)

The `frontend/` workspace contains a responsive, accessible dashboard powered by Next.js, React Query, and Playwright end-to-end tests.

1. **Install Node.js dependencies**
   ```bash
   cd frontend
   npm install
   ```
2. **Start the development server**
   ```bash
   npm run dev
   ```
   The web application will be available at `http://localhost:3000` and expects the FastAPI server to be running on `http://localhost:8000` by default.
3. **Run end-to-end tests**
   ```bash
   npm run test:e2e
   ```

   The tests use Playwright and automatically stub the FastAPI odds endpoint, so they can run without a live backend.

## Design & Accessibility

- Shared design tokens ensure consistent typography, colour, and spacing aligned with the target brand palette.
- The UI is responsive across mobile and desktop breakpoints, with WCAG AA-focused focus states, contrast, and keyboard navigation.
- Localization currently supports English (`en`) and Czech (`cs`) with a runtime language switcher.
