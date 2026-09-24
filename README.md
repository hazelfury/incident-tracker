# Incident Tracker — Backend

Week 2 deliverable: Express server architecture, middleware pipeline, and
database connection pooling for the Real-Time Incident Tracking & Service
Desk Management System.

## Structure

```
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
