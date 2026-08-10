# SiloCore

SiloCore is an open-source, full-stack AI chat platform for teams and developers who want a private application layer around dedicated or self-hosted AI infrastructure.

The project is currently in **active alpha**. Core chat, admin, user management, provider configuration, and local Ollama-backed inference flows are implemented, but APIs and setup details may still change.

## What It Does

- Provides authenticated AI chat for regular users.
- Streams assistant responses over server-sent events.
- Supports local Ollama inference through a persisted provider configuration system.
- Lets admins manage users, access status, provider settings, and model discovery.
- Keeps individual chat contents scoped to the owning user.
- Exposes aggregate admin analytics and system health without giving admins direct access to private user conversations.
- Ships as a TypeScript monorepo with a React frontend, Express backend, Prisma, PostgreSQL, and Docker Compose.

## Tech Stack

**Frontend**

- React, TypeScript, Vite
- Tailwind CSS
- React Router
- TanStack Query
- Axios
- React Hook Form and Zod

**Backend**

- Node.js, Express, TypeScript
- Prisma ORM
- PostgreSQL
- JWT authentication
- Ollama provider adapter
- Jest tests

**Local infrastructure**

- Docker Compose
- PostgreSQL 16
- Optional local Ollama runtime

## Project Structure

```text
.
├── backend/                 # Express API, Prisma schema, tests, Bruno API collection
├── frontend/                # React app and route-level feature modules
├── docker-compose.yml       # Local development stack
├── CONTRIBUTING.md          # Contribution guidance
└── LICENSE                  # Apache-2.0 license
```

The backend is organized by feature modules under `backend/src/modules`. Controllers handle HTTP parsing, services hold business rules, repositories handle Prisma access, and route files wire middleware and validation.

The frontend is organized by features under `frontend/src/features`, with shared layout, routing, UI, config, and API client utilities under `frontend/src`.

## Prerequisites

- Docker and Docker Compose
- Node.js 22.12+ if running backend services outside Docker
- npm
- Ollama if you want local model inference

For chat generation, start Ollama on your host machine and make sure the model configured in `backend/.env` is available.

```bash
ollama pull llama3.1
```

You can use a different model as long as `OLLAMA_MODEL` matches it.

## Quick Start With Docker

1. Copy the environment files:

   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```

2. Edit `backend/.env` and set a real JWT secret:

   ```env
   JWT_SECRET=replace_this_with_a_long_random_secret
   OLLAMA_HOST=http://host.docker.internal:11434
   OLLAMA_MODEL=llama3.1
   ```

3. Start the stack:

   ```bash
   docker compose up --build
   ```

Docker Compose starts PostgreSQL, applies Prisma migrations, seeds local demo users, and runs the backend worker on startup. The worker manages the pg-boss queue schema automatically. The frontend runs at `http://localhost:5173`, and the backend health check is available at `http://localhost:5000/health`.

### Local Demo Accounts

These accounts are created by the seed script for local development only:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `Admin123!` |
| User | `user@example.com` | `User123!` |

## Running Without Docker

Use this path when you want direct control over each service during development.

1. Start PostgreSQL and create a database named `silocore`.

2. Install backend dependencies:

   ```bash
   cd backend
   npm install
   cp .env.example .env
   ```

3. For a local PostgreSQL process, set `DATABASE_URL` in `backend/.env` to use `localhost`:

   ```env
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/silocore
   JWT_SECRET=replace_this_with_a_long_random_secret
   OLLAMA_HOST=http://localhost:11434
   OLLAMA_MODEL=llama3.1
   ```

4. Prepare the database and start the backend:

   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   npx prisma db seed
   npm run dev
   ```

5. In a second terminal, start the frontend:

   ```bash
   cd frontend
   npm install
   cp .env.example .env
   npm run dev
   ```

The frontend runs at `http://localhost:5173`. The default frontend API URL is `http://localhost:5000/api`.

## Environment Variables

Backend variables live in `backend/.env`:

| Variable | Purpose |
| --- | --- |
| `PORT` | Backend port, default `5000` |
| `NODE_ENV` | Runtime environment |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign JWTs |
| `OLLAMA_HOST` | Ollama base URL |
| `OLLAMA_MODEL` | Default model used when bootstrapping the local provider |
| `EMBEDDING_MODEL` | Reserved for embedding-related work |
| `WORKER_CONCURRENCY` | Worker handler concurrency, default `1` |
| `PISCINA_THREAD_COUNT` | Reserved worker CPU pool size, default `1` |
| `WORKER_SHUTDOWN_GRACE_MS` | Worker graceful shutdown timeout in milliseconds, default `30000` |
| `WORKER_JOB_HEARTBEAT_INTERVAL_MS` | Worker application job heartbeat interval in milliseconds, default `10000` |
| `PGBOSS_SCHEMA` | PostgreSQL schema used by pg-boss, default `pgboss` |

Frontend variables live in `frontend/.env`:

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Backend API base URL, usually `http://localhost:5000/api` |
| `VITE_APP_NAME` | App name displayed by the frontend |

## Main Application Areas

### User Chat

Regular users can create, retitle, delete, and search recent chat sessions. The chat workspace supports streaming responses, model selection, and generation settings such as temperature, top-p, max tokens, and stop sequences.

### Admin Console

Admins can manage user records, ban/reactivate/delete users, configure LLM providers, test provider connectivity, pull Ollama models, inspect model registry status, and view aggregate system statistics.

### LLM Provider Layer

Provider configuration is stored in PostgreSQL. API responses sanitize secrets by returning whether an API key exists instead of returning the key itself. Ollama is currently implemented. The provider type model also includes an OpenAI-compatible type, but that adapter is not implemented yet.

## API Overview

All API routes are mounted under `/api`.

| Area | Routes |
| --- | --- |
| Auth | `POST /api/auth/login` |
| Current user and admin user management | `/api/users/*` |
| Chat sessions, messages, and generation | `/api/chat/*` |
| Authenticated model registry | `/api/llm/*` |
| Admin provider management | `/api/admin/llm/providers/*` |
| Admin analytics and system status | `/api/admin/analytics/*`, `/api/admin/system/*` |

Authenticated requests use:

```http
Authorization: Bearer <jwt>
```

The backend includes a Bruno API collection under `backend/bruno/SiloCore` for manual API testing.

## Development Commands

Backend commands are run from `backend/`:

```bash
npm run dev
npm run dev:worker
npm run build
npm run start:worker
npm test
npm run test:integration
npm run lint
npm run prisma:generate
npm run prisma:migrate
npm run pgboss:plans
npm run pgboss:migrate
npm run pgboss:version
npm run pgboss:doctor
```

Frontend commands are run from `frontend/`:

```bash
npm run dev
npm run build
npm run lint
npm run test
npm run test:e2e
npm run preview
```

### End-to-End Tests

Playwright tests live in `frontend/e2e` and target the local browser app plus backend API.
They expect PostgreSQL, the backend, and the frontend to already be running. The Docker
flow is the recommended setup:

```bash
docker compose up --build
```

The backend container applies Prisma migrations and seeds the local demo users used by
the initial login tests. These tests cover seeded admin and regular-user login plus
role-based redirects, and they do not require Ollama or external LLM generation.

Before the first local Playwright run, install browser binaries:

```bash
cd frontend
npx playwright install
```

Run the suite from `frontend/`:

```bash
npm run test:e2e
```

Optional environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYWRIGHT_BASE_URL` | `http://localhost:5173` | Frontend URL under test |
| `PLAYWRIGHT_API_URL` | `http://localhost:5000/api` | Backend API base used by readiness checks |

## Testing

The backend uses Jest and includes tests for auth, users, chat, LLM provider behavior, provider config management, model registry aggregation, streaming flows, and system status logic.

```bash
cd backend
npm test
```

Backend integration tests are opt-in and use a disposable PostgreSQL database. Set
`INTEGRATION_DATABASE_URL` to a database whose name includes `test`; the harness drops,
recreates, migrates, and truncates that database during the run.

```bash
cd backend
INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/silocore_integration_test npm run test:integration
```

The frontend uses Vitest for unit tests and Playwright for local E2E coverage:

```bash
cd frontend
npm run test
npm run test:e2e
npm run build
npm run lint
```

## Contributing

Contributions are welcome. See `CONTRIBUTING.md` for setup notes, code style, and pull request guidance.

## License

SiloCore is licensed under the Apache License 2.0. See `LICENSE` for details.
