# Incident Tracker — Backend

Week 2: Express server architecture, middleware pipeline, and database
connection pooling.
Week 3: database schema for incidents, priority SLAs, user assignments, and
status change logs.

Backend for the Real-Time Incident Tracking & Service Desk Management System.

## Structure

```
database/
  schema.sql           the full schema — teams, users, categories, priorities,
                        incidents, incident_assignments, incident_status_history
scripts/
  migrate.js           applies database/schema.sql (npm run db:migrate)
  seed.js              inserts default priorities (SLAs) and categories, safe to re-run
src/
  app.js              Express app factory — assembles the middleware pipeline
  server.js           Entry point — starts the HTTP server, graceful shutdown
  config/
    env.js            Loads and defaults all environment variables
    database.js        Postgres pool (prod) / SQLite connection (dev+test)
  middleware/
    requestLogger.js   morgan request logging
    asyncHandler.js     wraps async route handlers so errors reach errorHandler
    notFound.js         404 handler
    errorHandler.js     centralized error -> JSON response handler
  routes/
    index.js            mounts feature routers under /api
    health.js            GET /api/health — verifies the DB connection is live
tests/
  setupEnv.js          forces DB_CLIENT=sqlite (:memory:) for tests
  health.test.js       supertest coverage of the health check and 404 path
  schema.test.js       migrates an in-memory DB, checks tables, the incident
                       status CHECK constraint, and SLA/assignment data
```

## Middleware pipeline (in order)

1. `helmet()` — security headers
2. `cors()` — restricts origins via `CORS_ORIGIN`
3. `express.json()` / `express.urlencoded()` — body parsing
4. `requestLogger` — request logging (skipped in test env)
5. feature routes, mounted under `/api`
6. `notFound` — catches anything no route matched
7. `errorHandler` — catches everything thrown/rejected above it

The two terminal handlers (`notFound`, `errorHandler`) must stay last —
Express matches middleware in registration order, and `errorHandler` only
catches errors from things registered *before* it.

## Database connection pooling

`src/config/database.js` exposes one interface — `query()`, `getClient()`,
`healthCheck()`, `close()` — regardless of which database is behind it,
selected via `DB_CLIENT`:

- **`postgres`** (staging/production): a `pg.Pool` with configurable
  `max`, `idleTimeoutMillis`, and `connectionTimeoutMillis`. The pool is
  created once at server startup (`db.init()` in `server.js`), not lazily
  on first request, so a bad `DATABASE_URL` fails fast on boot instead of
  on a user's request. A listener on the pool's `error` event stops a bad
  idle connection from crashing the process.
- **`sqlite`** (local dev & tests): a single `better-sqlite3` connection
  (file-backed locally, `:memory:` in tests) behind the same interface, so
  route/service code never has to branch on which database it's talking to.

`server.js` also handles `SIGTERM`/`SIGINT` to close the pool/connection
cleanly on shutdown, with a 10s force-exit fallback.

One dialect detail this layer handles for you: `pg` needs `$1, $2, ...`
placeholders while `better-sqlite3` needs `?`. `query()` always accepts `?`
and rewrites it to `$1, $2, ...` internally when `DB_CLIENT=postgres`, so
every call site — routes, scripts, tests — writes the same SQL either way.

## Database schema

`database/schema.sql` defines seven tables and runs unchanged on both
Postgres and SQLite (ids are app-generated UUID strings, so there's no
SERIAL/AUTOINCREMENT split to work around):

- **`teams`**, **`users`**, **`categories`** — supporting/reference data
- **`priorities`** — the SLA source of truth: `sla_response_mins` and
  `sla_resolution_mins` per level, so SLA targets live in one place instead
  of being hardcoded wherever they're checked
- **`incidents`** — the core record, with a `status` CHECK constraint
  restricting it to the seven lifecycle states from the Week 1 design
- **`incident_assignments`** — full assignment history (`assigned_to`,
  `assigned_by`, `assigned_at`/`unassigned_at`), not just whichever agent
  currently holds `incidents.assignee_id`
- **`incident_status_history`** — append-only log of every status
  transition (`from_status` -> `to_status`, who changed it, when)

Apply it and load default SLA/category data:

```bash
npm run db:migrate    # creates all tables (safe to re-run — IF NOT EXISTS)
npm run db:seed       # inserts P1–P4 priorities and default categories (safe to re-run)
```

## Running locally

```bash
cp .env.example .env      # defaults to DB_CLIENT=sqlite, no setup needed
npm install
npm run dev                # starts on http://localhost:4000
curl http://localhost:4000/api/health
```

To run against Postgres instead, set in `.env`:

```
DB_CLIENT=postgres
DATABASE_URL=postgres://user:password@localhost:5432/incident_tracker
```

## Tests

```bash
npm test
```

Tests force `DB_CLIENT=sqlite` with an in-memory database (`tests/setupEnv.js`)
so they run without any external services.

## Next weeks

This week is server plumbing only — no incident data yet. Feature routers
(`incidents`, `users`, `teams`, `notifications`) will mount in
`src/routes/index.js`, following the entity model from the Week 1
requirements doc, with `asyncHandler` + `errorHandler` giving them
consistent error handling for free.
