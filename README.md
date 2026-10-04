# Promise Tracker — Backend

> **"Every promise, with its receipt."**
>
> Evidence-gated commitment extraction from conversations.
> **Gemma proposes. Python verifies. Firestore remembers.**

---

## Table of Contents

1. [Project Purpose](#1-project-purpose)
2. [Architecture](#2-architecture)
3. [Folder Structure](#3-folder-structure)
4. [Requirements](#4-requirements)
5. [Python Version](#5-python-version)
6. [Virtual Environment Setup](#6-virtual-environment-setup)
7. [Dependency Installation](#7-dependency-installation)
8. [Firebase Setup](#8-firebase-setup)
9. [Environment Variables](#9-environment-variables)
10. [Gemma Configuration](#10-gemma-configuration)
11. [Running Locally](#11-running-locally)
12. [API Endpoints](#12-api-endpoints)
13. [Firestore Structure](#13-firestore-structure)
14. [Testing](#14-testing)
15. [Live Tests](#15-live-tests)
16. [Evaluation Dataset](#16-evaluation-dataset)
17. [Deployment (Render)](#17-deployment-render)
18. [Security](#18-security)
19. [Rate Limiting](#19-rate-limiting)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Project Purpose

Promise Tracker ingests a conversation, chat log, or meeting notes and
returns a structured **commitment ledger** — a list of promises with:

- **owner** — who made the commitment  
- **recipient** — who it was made to  
- **promise** — what was committed  
- **deadline** — normalised ISO-8601 date  
- **status** — `pending` / `completed` / `overdue` / `needs_confirmation`  
- **confidence** — AI confidence score [0, 1]  
- **evidence** — exact quote from the source text + verification status  

### Key innovation: Evidence-Gated Extraction

The AI (Gemma) proposes commitments. **Python independently verifies** that
every evidence quote exists verbatim in the original source text.  
If a quote cannot be verified, exactly **one** bounded repair attempt is made.  
If still invalid, the promise is **discarded** — never blindly trusted.

---

## 2. Architecture

```
Client (HTTP)
     │
     ▼
FastAPI  (app/main.py)
     │
     ├── RequestID Middleware  (X-Request-ID on every request/response)
     ├── RateLimit Middleware  (10 req/min/IP for POST /api/analyze)
     ├── CORS Middleware
     │
     ▼
Request Validation  (Pydantic schemas + input sanitization)
     │
     ▼
Analysis Service  (app/services/analysis_service.py)
     │
     ▼
AI Harness  (app/ai/harness.py)
     ├── Chunker  (app/processing/chunker.py)
     ├── Sanitizer  (app/processing/sanitize.py)
     ├── Prompt Builder  (app/ai/prompts.py)
     ├── Gemma Client  (app/ai/gemma_client.py)  ─── or Mock
     ├── AI Output Validator  (app/ai/validator.py)
     ├── Evidence Verifier  (app/processing/evidence.py)
     ├── Bounded Repair  (app/ai/repair.py)
     ├── Date Normaliser  (app/processing/dates.py)
     ├── Duplicate Merger  (app/processing/deduplication.py)
     └── Status Calculator
     │
     ▼
Validated PromiseCreate objects
     │
     ▼
Firestore Service  (app/services/firestore_service.py)
     ├── analyses/{id}
     ├── analyses/{id}/promises/{id}
     └── promiseIndex/{promise_id}  ← efficient lookup
     │
     ▼
API Response
```

**The AI layer NEVER writes to Firestore.**  
The flow is always: AI → Python validation → Firestore.

---

## 3. Folder Structure

```
backend/
├── app/
│   ├── main.py              # FastAPI app factory, middleware, CORS, routers
│   ├── config.py            # Pydantic Settings — all env vars
│   │
│   ├── middleware/
│   │   ├── request_id.py    # X-Request-ID on every request
│   │   └── rate_limit.py    # Per-IP sliding window rate limiter
│   │
│   ├── routes/
│   │   ├── health.py        # GET /health
│   │   ├── analyze.py       # POST /api/analyze, GET /api/analysis/{id},
│   │   │                    # GET /api/analysis/{id}/promises, GET /api/analyses
│   │   └── promises.py      # PATCH /api/promise/{id}, POST .../complete
│   │
│   ├── schemas/
│   │   ├── analysis.py      # AnalyzeRequest, AnalysisResponse, AnalysisRead,
│   │   │                    # AnalysisSummary, AnalysesListResponse
│   │   └── promise.py       # PromiseCreate, PromiseRead, PromiseUpdate, Evidence
│   │
│   ├── services/
│   │   ├── analysis_service.py   # Orchestration: harness → Firestore → response
│   │   ├── promise_service.py    # Promise CRUD, state transitions
│   │   └── firestore_service.py  # Firebase Admin SDK init, all Firestore ops,
│   │                             # promiseIndex management
│   │
│   ├── ai/
│   │   ├── gemma_client.py   # Gemini API wrapper (real Gemma 3)
│   │   ├── mock_client.py    # Deterministic mock (AI_PROVIDER=mock)
│   │   ├── harness.py        # Full extraction pipeline
│   │   ├── prompts.py        # All prompt templates
│   │   ├── validator.py      # AI JSON output validation
│   │   └── repair.py         # Bounded repair (exactly 1 attempt)
│   │
│   ├── processing/
│   │   ├── chunker.py        # Message-aware chunking + context budget
│   │   ├── dates.py          # Relative → absolute date normalisation
│   │   ├── evidence.py       # Quote verification against source text
│   │   ├── deduplication.py  # Duplicate detection and merging
│   │   └── sanitize.py       # Input sanitization (NUL, control chars, etc.)
│   │
│   └── utils/
│       └── logging.py        # Structured logging (never logs raw text or keys)
│
├── tests/
│   ├── conftest.py                 # Fixtures, singleton resets, mock env vars
│   ├── test_health.py              # GET /health
│   ├── test_schemas.py             # Pydantic validation
│   ├── test_evidence.py            # Evidence verification
│   ├── test_dates.py               # Date normalisation
│   ├── test_deduplication.py       # Duplicate merging
│   ├── test_sanitize.py            # Input sanitization
│   ├── test_harness.py             # AI harness pipeline (mock AI)
│   ├── test_firestore_service.py   # All Firestore operations (fake DB)
│   ├── test_api.py                 # Full API integration (fake Firestore, mock AI)
│   ├── test_rate_limit.py          # Rate limiter tests
│   ├── test_live_firestore.py      # [LIVE] Real Firestore (RUN_LIVE_TESTS=1)
│   ├── test_live_gemma.py          # [LIVE] Real Gemma API (RUN_LIVE_TESTS=1)
│   └── test_e2e.py                 # [LIVE] Full E2E acceptance test
│
├── evaluation/
│   └── dataset.py            # 19 evaluation cases across 12 categories
│
├── .env.example              # Template — copy to .env and fill in
├── .gitignore                # Excludes .env, service accounts, __pycache__, etc.
├── pytest.ini                # pytest configuration
├── render.yaml               # Render deployment configuration
├── requirements.txt          # Python dependencies
├── run.py                    # Convenience entry point
└── README.md                 # This file
```

---

## 4. Requirements

- Python 3.11 or 3.12 or 3.13
- A Firebase project (free Spark plan is sufficient for development)
- A Gemini API key (only needed when `AI_PROVIDER=gemma`)
- Internet access (for Firestore and Gemini API calls)

---

## 5. Python Version

```bash
python3 --version
# Tested on Python 3.13.14
```

---

## 6. Virtual Environment Setup

```bash
cd backend/

# Create virtual environment
python3 -m venv .venv

# Activate (Linux / macOS)
source .venv/bin/activate

# Activate (Windows)
.venv\Scripts\activate
```

---

## 7. Dependency Installation

```bash
pip install -r requirements.txt
```

---

## 8. Firebase Setup

### Create a Firebase project

1. Go to <https://console.firebase.google.com/>
2. Create a new project (or use an existing one).
3. In **Project settings → Service accounts**, click **Generate new private key**.
4. Download the JSON file.

### Enable Firestore

In the Firebase console: **Build → Firestore Database → Create database**.  
Choose **Start in test mode** for development, **production mode** for production.

### Option A — JSON file path (simplest for local dev)

```
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/serviceAccountKey.json
```

Do **not** commit this file. It is already in `.gitignore`.

### Option B — Inline environment variables (recommended for Render)

Copy the values from the downloaded JSON file:

```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
```

**Note**: the private key contains literal `\n` newlines. In `.env`,
wrap the entire value in double quotes and use `\n` for newlines.
The backend automatically converts `\n` → real newlines before passing to Firebase Admin.

### Firestore Index for promiseIndex

The `promiseIndex` collection enables O(1) promise lookups without scanning
all analyses. No special composite index is needed for Phase 1 — single-document
reads are used.

If you use `find_promise_by_id` with a collection-group query, Firestore may
request a composite index. The Firebase console will provide the index creation
link in the error message.

### Development vs. production

Use **separate Firebase projects** for development and production.  
Set the corresponding credentials in your environment.  
Never use a production Firestore database for development or testing.

---

## 9. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `ENVIRONMENT` | No | `development` | `development` or `production` |
| `AI_PROVIDER` | No | `mock` | `mock` (no API) or `gemma` (real) |
| `GEMMA_API_KEY` | If `gemma` | — | Your Gemini API key |
| `GEMMA_MODEL` | No | `gemma-3-27b-it` | Gemma model name |
| `FIREBASE_PROJECT_ID` | Yes* | — | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes* | — | Service account email |
| `FIREBASE_PRIVATE_KEY` | Yes* | — | Service account private key |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Alternative | — | Path to JSON file |
| `ALLOWED_ORIGINS_RAW` | No | `http://localhost:5173,...` | Comma-separated CORS origins |
| `CONFIDENCE_THRESHOLD` | No | `0.4` | Min AI confidence to accept a promise |
| `MAX_DOCUMENT_LENGTH` | No | `100000` | Max chars per document |
| `RATE_LIMIT_PER_MINUTE` | No | `10` | Requests/min/IP for POST /analyze |

*Required when `AI_PROVIDER=gemma` or when using real Firestore.

---

## 10. Gemma Configuration

The backend uses **Gemma 3** via the Gemini API.

Obtain an API key at <https://aistudio.google.com/apikey>.

Available models (as of Oct 2025):
- `gemma-3-27b-it` — highest quality, recommended for production
- `gemma-3-12b-it` — balanced performance  
- `gemma-3-4b-it` — fastest, lowest cost

Set in `.env`:
```
GEMMA_API_KEY=your_key_here
GEMMA_MODEL=gemma-3-27b-it
AI_PROVIDER=gemma
```

For local development without spending credits:
```
AI_PROVIDER=mock
```

---

## 11. Running Locally

### Quick start (mock AI, no Firebase)

```bash
cd backend/
source .venv/bin/activate

# Minimal environment for mock mode
export AI_PROVIDER=mock
export FIREBASE_PROJECT_ID=dev-test
export FIREBASE_CLIENT_EMAIL=test@dev.iam.gserviceaccount.com
export FIREBASE_PRIVATE_KEY="fake"

uvicorn app.main:app --reload --port 8000
```

Or using the convenience script:
```bash
python run.py
```

### Full mode (real Gemma + real Firestore)

```bash
# Fill in .env with real credentials, then:
uvicorn app.main:app --reload --port 8000
```

The server will be available at:
- API: `http://localhost:8000`
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

---

## 12. API Endpoints

### `GET /health`

Liveness check. No authentication required.

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

---

### `POST /api/analyze`

Submit a conversation for commitment extraction.

**Rate limited**: 10 requests/minute/IP (per-process, in-memory).

```bash
curl -s -X POST http://localhost:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "document": "Rahul: I'\''ll send the PPT tomorrow.\nPriya: I'\''ll review it on Friday.",
    "reference_date": "2026-10-04"
  }' | python3 -m json.tool
```

Response (201 Created):
```json
{
  "analysis_id": "abc123",
  "promises": [
    {
      "id": "p1",
      "owner": "Rahul",
      "recipient": "Team",
      "promise": "Send the PPT",
      "deadline": "2026-10-05",
      "status": "pending",
      "confidence": 0.94,
      "evidence": {
        "quote": "I'll send the PPT tomorrow.",
        "verified": true
      }
    }
  ]
}
```

---

### `GET /api/analyses`

List all analyses, newest first, with pagination.

```bash
curl "http://localhost:8000/api/analyses?limit=10"
curl "http://localhost:8000/api/analyses?limit=10&cursor=NEXT_CURSOR"
```

Response:
```json
{
  "analyses": [
    {
      "analysis_id": "abc123",
      "source_text_length": 80,
      "reference_date": "2026-10-04",
      "created_at": "...",
      "promise_count": 3
    }
  ],
  "next_cursor": "abc124",
  "total_returned": 10
}
```

---

### `GET /api/analysis/{analysis_id}`

Retrieve a stored analysis and all its promises.

```bash
curl http://localhost:8000/api/analysis/abc123 | python3 -m json.tool
```

---

### `GET /api/analysis/{analysis_id}/promises`

List promises for an analysis with optional status filtering.

```bash
# All promises
curl http://localhost:8000/api/analysis/abc123/promises

# Filter by status
curl "http://localhost:8000/api/analysis/abc123/promises?status=pending"
curl "http://localhost:8000/api/analysis/abc123/promises?status=completed"
curl "http://localhost:8000/api/analysis/abc123/promises?status=overdue"
curl "http://localhost:8000/api/analysis/abc123/promises?status=needs_confirmation"
```

---

### `PATCH /api/promise/{promise_id}`

Update editable fields. Protected fields (`evidence.verified`, `confidence`) are immutable.

```bash
curl -s -X PATCH http://localhost:8000/api/promise/p1 \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "deadline": "2026-11-15"}' | python3 -m json.tool
```

---

### `POST /api/promise/{promise_id}/complete`

Mark a promise completed. Idempotent.

```bash
curl -s -X POST http://localhost:8000/api/promise/p1/complete | python3 -m json.tool
```

---

### Error Envelope

All errors use a consistent JSON structure:

```json
{
  "error": {
    "code": "not_found",
    "message": "Promise 'p1' not found.",
    "details": [],
    "request_id": "abc-123-def-456"
  }
}
```

Every request and response carries an `X-Request-ID` header.

---

## 13. Firestore Structure

```
analyses/
  {analysis_id}/
    sourceTextLength: int      ← character count (NOT raw text)
    referenceDate:    "2026-10-04"
    promiseCount:     3
    createdAt:        Timestamp
    updatedAt:        Timestamp

    promises/
      {promise_id}/
        owner:      "Rahul"
        recipient:  "Team"
        promise:    "Send the final PPT version to the team"
        deadline:   "2026-10-05"
        status:     "pending"
        confidence: 0.96
        evidence:
          quote:    "I'll send the final version to the team tomorrow."
          verified: true
        createdAt:  Timestamp
        updatedAt:  Timestamp

promiseIndex/
  {promise_id}/
    analysisId: "abc123"    ← enables O(1) cross-analysis lookup
    owner:      "Rahul"
    promise:    "Send the PPT"  (truncated to 80 chars)
    status:     "pending"
    createdAt:  Timestamp
```

**Privacy**: raw source text is **never** stored. Only its character length.

**Performance**: `promiseIndex` enables PATCH/complete endpoints to find any
promise in O(1) without scanning every analysis.

---

## 14. Testing

### Run all offline tests (no external credentials needed)

```bash
cd backend/
python3 -m pytest -v
```

**177 tests** run against mock AI and an in-memory Firestore fake.

### Run specific test files

```bash
python3 -m pytest tests/test_health.py -v
python3 -m pytest tests/test_evidence.py -v
python3 -m pytest tests/test_dates.py -v
python3 -m pytest tests/test_deduplication.py -v
python3 -m pytest tests/test_sanitize.py -v
python3 -m pytest tests/test_harness.py -v
python3 -m pytest tests/test_firestore_service.py -v
python3 -m pytest tests/test_api.py -v
python3 -m pytest tests/test_rate_limit.py -v
```

### Coverage areas

| File | What it tests |
|---|---|
| `test_health.py` | `/health` endpoint |
| `test_schemas.py` | Pydantic validation, edge cases |
| `test_evidence.py` | Quote verification, whitespace, paraphrase detection |
| `test_dates.py` | `today/tomorrow/next Friday/in N days/ISO` normalisation |
| `test_deduplication.py` | Merge policy, confidence, evidence, deadline preference |
| `test_sanitize.py` | NUL chars, control chars, unicode preservation, idempotency |
| `test_harness.py` | Full pipeline: evidence discard, repair, deadline norm, confidence |
| `test_firestore_service.py` | All Firestore CRUD, promiseIndex, filtering, overdue |
| `test_api.py` | Full HTTP API, all endpoints, security checks |
| `test_rate_limit.py` | 429 rate limit behavior, correct path targeting |

---

## 15. Live Tests

These require real credentials and explicit opt-in.

### Live Firestore tests

```bash
RUN_LIVE_TESTS=1 \
FIREBASE_PROJECT_ID=your-project \
FIREBASE_CLIENT_EMAIL=your@email.iam.gserviceaccount.com \
FIREBASE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n" \
python3 -m pytest tests/test_live_firestore.py -v -s
```

Covers: real connection, create/read analysis, create/read promise, promiseIndex lookup,
update, complete, status filtering, timestamps, cleanup.

### Live Gemma API tests

```bash
RUN_LIVE_TESTS=1 \
GEMMA_API_KEY=your_key \
python3 -m pytest tests/test_live_gemma.py -v -s
```

Covers: real API call, structured JSON parsing, evidence verification, deadline normalization, full harness pipeline.

### Full end-to-end acceptance test

```bash
RUN_LIVE_TESTS=1 \
GEMMA_API_KEY=your_key \
FIREBASE_PROJECT_ID=... \
FIREBASE_CLIENT_EMAIL=... \
FIREBASE_PRIVATE_KEY=... \
python3 -m pytest tests/test_e2e.py -v -s
```

Runs the full acceptance scenario: 3-promise conversation → Gemma → verify → Firestore → read back → update → complete → filter → pagination → no-secrets check.

---

## 16. Evaluation Dataset

The `evaluation/dataset.py` module contains 19 evaluation cases across 12 categories:

1. Explicit commitments
2. Implicit commitments
3. Non-commitments
4. Ambiguous commitments
5. Multiple commitments
6. Different speakers
7. Different recipients
8. Relative dates
9. Missing deadlines
10. Invalid evidence scenarios
11. Duplicate commitments
12. Conflicting information

Run offline evaluation (mock AI):
```bash
cd backend/
python3 evaluation/dataset.py
```

**Note**: Offline results use mock AI and reflect schema behavior, not real Gemma accuracy.
Real accuracy metrics require `RUN_LIVE_TESTS=1 + GEMMA_API_KEY`.

---

## 17. Deployment (Render)

### Setup

1. Create a new **Web Service** on [Render](https://render.com/).
2. Connect your GitHub repository.
3. Set **Root Directory** to `backend/`.
4. Render will auto-detect `render.yaml`.
5. Add environment variables in Render's **Environment** panel.

### Required environment variables on Render

```
ENVIRONMENT=production
AI_PROVIDER=gemma
GEMMA_API_KEY=your_key
GEMMA_MODEL=gemma-3-27b-it
FIREBASE_PROJECT_ID=your_project
FIREBASE_CLIENT_EMAIL=your@email.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n
ALLOWED_ORIGINS_RAW=https://your-frontend.vercel.app
CONFIDENCE_THRESHOLD=0.4
RATE_LIMIT_PER_MINUTE=10
```

### Start command

```
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Render automatically sets the `PORT` variable.

### Health check path

```
/health
```

---

## 18. Security

**NEVER commit:**
- `.env` or any `.env.*` file
- Firebase service account JSON
- Gemini API keys

**The `.gitignore` already excludes all of the above.**

Additional rules enforced in this codebase:

| Concern | Implementation |
|---|---|
| Raw conversation text | Never logged, never stored to Firestore |
| API keys / credentials | Never logged, never in responses |
| Stack traces | Never exposed in production error responses |
| Firebase internals | Never exposed in API errors |
| Evidence.verified / confidence | Protected from client modification via PATCH |
| AI output | Never saved to Firestore without Python verification |
| Input NUL / control chars | Sanitized before processing |
| Oversized documents | Rejected at schema validation (100k char limit) |
| CORS | Configurable origins, never `*` in production |
| X-Request-ID | Sanitized: alphanumeric + hyphens, max 64 chars |

---

## 19. Rate Limiting

`POST /api/analyze` is protected by an in-memory sliding window rate limiter.

**Default**: 10 requests per minute per IP address.

**Configure** via `RATE_LIMIT_PER_MINUTE` environment variable.

**Important limitation**: This limiter is **per-process**. On Render with
multiple instances, each instance maintains its own counter. The effective
global limit is `RATE_LIMIT_PER_MINUTE × number_of_instances`.

For production-grade global rate limiting, use an external service such as:
- Cloudflare Workers (in front of Render)
- Redis + a distributed rate-limiting library
- Render's built-in DDoS protection (paid plans)

---

## 20. Troubleshooting

### `RuntimeError: Firebase credentials are not configured`
Set at least `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and
`FIREBASE_PRIVATE_KEY` in `.env`, or set `FIREBASE_SERVICE_ACCOUNT_PATH`.

### `RuntimeError: GEMMA_API_KEY is not set`
Set `GEMMA_API_KEY` in `.env`, or switch to `AI_PROVIDER=mock`.

### `422 Unprocessable Entity` on `/api/analyze`
- Check that `document` is not empty or blank.
- Check that `reference_date` is a valid ISO-8601 date (`YYYY-MM-DD`).
- Check that `document` is under 100,000 characters.

### `429 Too Many Requests`
You have exceeded 10 requests/minute for `POST /api/analyze`.
Wait 60 seconds and retry.

### Firestore `PermissionDenied`
Verify your service account has the **Cloud Datastore User** or
**Firebase Admin** role in Google Cloud IAM.

### `PRIVATE_KEY` encoding issues
If your private key contains literal `\n` in the environment variable,
the `firestore_service.py` automatically replaces `\\n` → `\n` before
passing to Firebase Admin.

### Missing Firestore index warning
If you see a Firestore index error, visit the link in the error message
to create the required composite index in the Firebase console.
