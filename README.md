# Incident Tracker — Backend

Week 2: Express server architecture, middleware pipeline, database connection pooling.
Week 3: database schema for incidents, priority SLAs, user assignments, status change logs.
Week 4: REST API endpoints for incident creation, assignment updates, and resolution timestamps.

Backend for the Real-Time Incident Tracking & Service Desk Management System.

## Structure

```
database/
  schema.sql            the full schema — see Week 3 section below
scripts/
  migrate.js             applies database/schema.sql (npm run db:migrate)
  seed.js                 default priorities (SLAs) and categories (npm run db:seed)
src/
  app.js                Express app factory — middleware pipeline
  server.js              entry point — starts the HTTP server, graceful shutdown
  config/
    env.js                environment variables, with defaults
    database.js            Postgres pool / SQLite connection, query() + withTransaction()
  middleware/
    requestLogger.js       morgan request logging
    asyncHandler.js         wraps async route handlers
    notFound.js             404 handler
    errorHandler.js         centralized error -> JSON response handler
  utils/
    httpError.js            HttpError(statusCode, message) for operational errors
  services/
    incidentService.js      business logic: create, assign, status/resolution transitions
  controllers/
    incidentsController.js  thin HTTP layer over incidentService
  routes/
    index.js                mounts feature routers under /api
    health.js                 GET /api/health
    incidents.js               incident endpoints (below)
tests/
  setupEnv.js             forces DB_CLIENT=sqlite (:memory:) for tests
  health.test.js          health check + 404 coverage
  schema.test.js          migration, CHECK constraint, SLA/assignment data
  incidents.test.js       full incident API coverage (see Week 4 section below)
```

## Week 2 — server architecture

**Middleware pipeline** (`src/app.js`, in order): `helmet` → `cors` → body parsing →
request logging → routes (`/api`) → `notFound` → `errorHandler`. The two terminal
handlers must stay last — Express only routes errors to handlers registered
after whatever threw.

**Connection pooling** (`src/config/database.js`): one `query()`/`getClient()`
interface regardless of which database is behind it, picked via `DB_CLIENT`:
a `pg.Pool` (configurable size/timeouts, an `error` listener so a bad idle
connection can't crash the process) for Postgres, or a single
`better-sqlite3` connection for local dev/tests. The pool is created once at
startup (`db.init()`), not lazily on first request.

One dialect detail this layer handles: `pg` needs `$1, $2, ...` placeholders,
`better-sqlite3` needs `?`. Every call site writes `?`; `query()` converts it
automatically when `DB_CLIENT=postgres`.

## Week 3 — database schema

`database/schema.sql` — seven tables, unchanged SQL on both Postgres and
SQLite (ids are app-generated UUID strings, no SERIAL/AUTOINCREMENT split):

- **`teams`**, **`users`**, **`categories`** — reference data
- **`priorities`** — the SLA source of truth: `sla_response_mins` /
  `sla_resolution_mins` per level
- **`incidents`** — the core record; `status` is CHECK-constrained to the
  seven lifecycle states
- **`incident_assignments`** — full assignment history, not just the
  current `assignee_id`
- **`incident_status_history`** — append-only log of every status
  transition

```bash
npm run db:migrate    # creates all tables (safe to re-run)
npm run db:seed       # loads P1-P4 priorities and default categories (safe to re-run)
```

## Week 4 — REST API

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/incidents` | Create an incident |
| GET | `/api/incidents` | List incidents |
| GET | `/api/incidents/:id` | Get one incident, with its assignment and status history |
| PATCH | `/api/incidents/:id/assignment` | Assign or reassign |
| PATCH | `/api/incidents/:id/status` | Change status (sets `resolved_at`/`closed_at`) |

**Create** — `POST /api/incidents`
```json
{ "title": "VPN down", "description": "optional", "reporterId": "<user id>", "categoryId": "<category id>", "priorityId": "<priority id>", "teamId": "optional" }
```
Validates all referenced ids exist, inserts the incident in `new` status,
computes `due_at` from the priority's `sla_resolution_mins`, and logs the
initial row to `incident_status_history` — all in one transaction.

**Assign** — `PATCH /api/incidents/:id/assignment`
```json
{ "assignedTo": "<user id>", "assignedBy": "<user id>", "reason": "optional" }
```
Closes out any currently-open `incident_assignments` row (`unassigned_at`),
opens a new one, and updates `incidents.assignee_id`. If the incident is
still `new`, this also advances it to `assigned` and logs that transition.
Rejects with 409 if the incident is already `closed`/`cancelled`.

**Change status** — `PATCH /api/incidents/:id/status`
```json
{ "status": "in_progress", "changedBy": "<user id>", "note": "optional" }
```
This is where resolution timestamps get set: `resolved_at` the moment
status becomes `resolved`, `closed_at` the moment it becomes `closed`; both
clear again if the incident is reopened back to `in_progress`. Every
transition is logged to `incident_status_history`. Invalid transitions
(e.g. `assigned` straight to `resolved`) return 409 with the allowed next
states for that incident.

Allowed transitions:
```
new          -> assigned, cancelled
assigned     -> in_progress, cancelled
in_progress  -> on_hold, resolved, cancelled
on_hold      -> in_progress
resolved     -> closed, in_progress   (reopen)
closed       -> in_progress            (reopen)
cancelled    -> (terminal)
```

### Why a transaction helper

Several of these operations touch more than one table and need to stay
atomic — assigning an incident writes `incident_assignments` *and*
`incidents` *and* possibly `incident_status_history` together. `src/config/database.js`
exports `withTransaction(fn)`, which runs `BEGIN`/`COMMIT` (or `ROLLBACK` on
error) around a callback that receives a `query()` function bound to that
one connection, using the same `?` placeholder convention as everywhere
else. `incidentService.js` uses this for every multi-write operation.

### Running locally

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev                # http://localhost:4000
```

```bash
curl -X POST http://localhost:4000/api/incidents \
  -H "Content-Type: application/json" \
  -d '{"title":"VPN down","reporterId":"<id>","categoryId":"<id>","priorityId":"<id>"}'
```

### Tests

```bash
npm test
```

`tests/incidents.test.js` covers: creation (including validation failures),
assignment (including reassignment history and unknown-user rejection), the
full status walk through `in_progress` → `resolved` → `closed` with
timestamp checks, rejected invalid transitions, reopening clearing
`resolved_at`, and the full `statusHistory` trail via `GET`.

Tests force `DB_CLIENT=sqlite` with an in-memory database (`tests/setupEnv.js`)
so they run without any external services.

## Next weeks

Notifications and audit-facing read endpoints (beyond what's already logged
to `incident_status_history`) are the natural next step, along with
authentication/authorization on top of the `users.role` column that's
already in the schema.
