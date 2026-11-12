# Incident Tracker — Backend

Week 2: Express server architecture, middleware pipeline, database connection pooling.
Week 3: database schema for incidents, priority SLAs, user assignments, status change logs.
Week 4: REST API endpoints for incident creation, assignment updates, and resolution timestamps.
Week 5: responsive front-end dashboard with priority color-coding and status filters.
Week 6: SLA breach calculation and automated priority escalation based on incident age.
Week 7: comprehensive unit and integration tests for incident lifecycle state transitions.

Backend for the Real-Time Incident Tracking & Service Desk Management System.

## Structure

```
database/
  schema.sql            the full schema — see Week 3 section below
scripts/
  migrate.js             applies database/schema.sql (npm run db:migrate)
  seed.js                 default priorities (SLAs) and categories (npm run db:seed)
  seed-demo.js            sample users and incidents for the dashboard (npm run db:demo)
  run-escalation.js       run or preview one escalation cycle (npm run sla:escalate)
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
  domain/                      pure business rules: no database, no clock of their own
    incidentLifecycle.js        the status rules: transition table, timestamps, who can be assigned
    slaCalculator.js            SLA evaluation, on-hold pausing
    escalationPolicy.js         "should this incident escalate now, and to what?"
  jobs/
    escalationJob.js            runs the escalation cycle on a timer
  utils/
    clock.js                    source of "now" for lifecycle timestamps (swapped out in tests)
    httpError.js            HttpError(statusCode, message) for operational errors
  services/
    incidentService.js      business logic: create, assign, status/resolution transitions, reads
    lookupService.js         priority levels + SLA targets
    slaService.js            loads what the SLA calculation needs and attaches it to incidents
    escalationService.js     runs one escalation cycle (dry run supported)
  controllers/
    incidentsController.js  thin HTTP layer over incidentService
  routes/
    index.js                mounts feature routers under /api
    health.js                 GET /api/health
    incidents.js               incident endpoints (below)
    priorities.js              GET /api/priorities
    escalations.js             POST /api/escalations/run
public/                      the dashboard front-end, served by Express at /
  index.html
  css/styles.css
  js/dashboard-utils.js       pure helpers (filtering, sorting, SLA text), unit-tested
  js/app.js                   fetching, rendering, filters, detail dialog
tests/
  setupEnv.js             forces DB_CLIENT=sqlite (:memory:) for tests
  health.test.js          health check + 404 coverage
  schema.test.js          migration, CHECK constraint, SLA/assignment data
  incidents.test.js       full incident API coverage (see Week 4 section below)
  dashboardApi.test.js    enriched list, status filter, priorities, static serving
  dashboardUtils.test.js  unit tests for the front-end helpers
  slaCalculator.test.js   every SLA rule, with exact times
  escalation.test.js      escalation policy, the cycle against a database, API, scheduler
  lifecycle.domain.test.js        unit: the transition rules and cross-module agreement
  lifecycle.transitions.test.js   integration: every transition through the HTTP API
  lifecycle.invariants.test.js    200 seeded random walks checking invariants after every step
  helpers/                        shared test spec (the rules, written out independently) and harness
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

| Method | Path                            | Purpose                                                  |
| ------ | ------------------------------- | -------------------------------------------------------- |
| POST   | `/api/incidents`                | Create an incident                                       |
| GET    | `/api/incidents`                | List incidents                                           |
| GET    | `/api/incidents/:id`            | Get one incident, with its assignment and status history |
| PATCH  | `/api/incidents/:id/assignment` | Assign or reassign                                       |
| PATCH  | `/api/incidents/:id/status`     | Change status (sets `resolved_at`/`closed_at`)           |

**Create** — `POST /api/incidents`

```json
{
  "title": "VPN down",
  "description": "optional",
  "reporterId": "<user id>",
  "categoryId": "<category id>",
  "priorityId": "<priority id>",
  "teamId": "optional"
}
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

`new -> assigned` is in the table, but the **status endpoint refuses it** (409): only
`PATCH /api/incidents/:id/assignment` can move an incident to `assigned`, because that
is what records who it is assigned to. (Week 7 fixed a gap here; see below.)

### Why a transaction helper

Several of these operations touch more than one table and need to stay
atomic — assigning an incident writes `incident_assignments` _and_
`incidents` _and_ possibly `incident_status_history` together. `src/config/database.js`
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

## Week 5 — front-end dashboard

Open `http://localhost:4000/` once the server is running. It's plain
HTML/CSS/JavaScript (no framework or build step) served by Express from
`public/`.

**What it shows**

- **Summary cards**: open incidents, critical (P1) open, past SLA due time, unassigned.
- **Priority color-coding**: every row has a colored edge and a filled badge
  (P1 red, P2 orange, P3 amber, P4 green; anything else neutral grey). The
  badge always carries the priority name too, so color is never the only signal.
  A legend under the filters shows each level and its resolution target.
- **Status filters**: one chip per status with a live count, plus an "All" chip.
  Status badges are outlined (priority badges are filled) so the two don't get confused.
- **Extra filters**: priority dropdown and a text search over title, assignee,
  category, reporter and priority. Counts on the status chips follow the other
  filters, so each chip shows what clicking it would give you.
- **SLA column**: "Due in 2h 59m" / "Overdue by 6h" for open incidents, and
  "Resolved on time" / "Resolved late" for finished ones.
- **Detail dialog**: click an incident title for its facts, assignment history
  and status history (who, when, and any note).
- **Auto-refresh** every 30 seconds (toggle in the header) plus a manual Refresh button.

**Responsive**: the table becomes a stack of cards below 760px wide, with the
same priority-colored edge. It follows the system light/dark setting.

**Accessibility**: filter chips are real buttons with `aria-pressed`, keyboard
focus is kept when the list re-renders, the dialog closes with Esc, and
result counts are announced via a live region.

**Sorting**: open incidents first; within them by priority, then soonest due
date; finished incidents come last.

### API additions this week

| Method | Path                 | Notes                                                                                                                                                                                                                                      |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/incidents`     | Now includes `priority_name`, `priority_level`, `category_name`, `team_name`, `assignee_name`, `reporter_name`. Optional `?status=new` or `?status=new,assigned`; unknown statuses return 400. Capped at 500 rows until pagination exists. |
| GET    | `/api/incidents/:id` | Assignment and status history rows now include the person's name.                                                                                                                                                                          |
| GET    | `/api/priorities`    | Priority levels with SLA targets, ordered most urgent first.                                                                                                                                                                               |

The dashboard loads the full list and filters in the browser so the status
counts stay visible; `?status=` is there for other clients.

### Sample data

```bash
npm run db:migrate
npm run db:seed
npm run db:demo      # 15 sample incidents across every priority and status (safe to re-run)
npm run dev          # then open http://localhost:4000/
```

`db:demo` creates incidents through the real service functions, then spreads
their timestamps over realistic ages. Ages are relative to when you run it, so
re-create the database (delete `data/dev.sqlite3`, then migrate, seed, demo)
if you want fresh overdue/due-soon examples later.

### Security header note

Helmet's default Content-Security-Policy includes `upgrade-insecure-requests`.
That makes some browsers (Safari especially) try to load the page's CSS/JS
over https from plain-http localhost, so the page appears unstyled. That one
directive is turned off in `src/app.js`; the rest of the CSP is unchanged,
and there are no inline scripts or styles.

### Known limits

- No pagination yet (500-row cap on the list).
- Timestamps are stored in `TIMESTAMP` columns. On Postgres those have no time
  zone, so check how dates display once this runs against a real Postgres
  server in a non-UTC time zone.
- The dashboard is read-only; creating and updating incidents is still done through the API.

## Week 6 — SLA breach calculation and automatic escalation

### How SLA is calculated

Each incident has two SLAs, both defined per priority in the `priorities` table.

**Resolution SLA** — resolve by `incidents.due_at` (set at creation from the
priority's `sla_resolution_mins`).

| Status           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `on_track`       | Less than 80% of the target time used                                         |
| `at_risk`        | 80% or more used, not yet breached                                            |
| `breached`       | Target time exceeded. For a finished incident this means it was resolved late |
| `paused`         | Currently on hold, within target                                              |
| `met`            | Resolved within target                                                        |
| `not_applicable` | Cancelled                                                                     |

- **On-hold time pauses the clock**, as designed in Week 1. Elapsed time is
  `(now or resolved time) - created - time spent on hold`, and the effective due
  date is pushed out by the same amount. An incident that was already past its
  deadline when it went on hold stays `breached`.
- The 80% "at risk" line is `SLA_AT_RISK_PERCENT`.
- The target is judged from the stored `due_at`, not from the incident's current
  priority (see "Design decisions" below).

**Response SLA** — the incident must be picked up (first assignment) within the
priority's `sla_response_mins` of creation. Statuses: `pending`, `met`,
`breached`, `not_applicable`. It is judged against the priority the incident
had when it was created.

Every incident returned by `GET /api/incidents` and `GET /api/incidents/:id`
now carries an `sla` object with both evaluations, plus `escalation_count` and
`original_priority_name`. The detail view also returns the full `escalations` history.

### How escalation works

An open incident (`new`, `assigned` or `in_progress`) is raised **one priority
level** once it has spent `ESCALATION_THRESHOLD_PERCENT` (default 75%) of its
current priority's resolution target at that priority without being resolved.

With the default SLAs that gives:

| From          | Target | Escalates after | To                |
| ------------- | ------ | --------------- | ----------------- |
| P4 - Low      | 3d     | 2d 6h           | P3                |
| P3 - Medium   | 1d     | 18h             | P2                |
| P2 - High     | 8h     | 6h              | P1                |
| P1 - Critical | 4h     | never           | (already highest) |

Each escalation writes a row to `incident_escalations` (who/what/when/why;
`escalated_by` is empty for the automatic job). The job runs inside the server
every `ESCALATION_INTERVAL_SECONDS` (default 60), once at startup.

### Design decisions

- **Time is measured from the last priority change, not from creation.**
  Otherwise a 3-day-old P4 ticket would be above every threshold and climb
  P4 → P3 → P2 → P1 on consecutive runs, minutes apart. Now each step has to be
  earned: after a P3 → P2 escalation the incident needs another 6 hours before
  it can reach P1.
- **Escalation never moves the original deadline.** `due_at` is left alone.
  Recalculating it from the new priority would flag a breach caused by the
  escalation itself (a 20-hour-old P3 raised to P2 would instantly be "over" P2's
  8-hour target). It is also why the SLA reads the stored `due_at` rather than
  the current priority.
- **On-hold incidents are never escalated**, and hold time is excluded from the
  age: their clock is paused, so their age isn't growing.
- **At most one level per incident per run**, and each escalation is its own
  transaction (priority change + audit row together or not at all). One failing
  incident doesn't stop the rest.
- **Safe to re-run.** Running the job twice in a row does nothing the second time.

### Running it

```bash
npm run db:migrate           # adds the incident_escalations table (existing data is untouched)
npm run db:demo              # sample incidents, including some old enough to escalate
npm run sla:escalate -- --dry-run   # preview: what WOULD escalate, changes nothing
npm run sla:escalate                # do it now
npm run dev                         # the server also runs the job every 60 seconds
```

The server runs the escalation job as soon as it starts, so run the dry run
**before** `npm run dev` if you want to see incidents waiting to be escalated.
Set `ESCALATION_ENABLED=false` to turn the timer off. You can also trigger it
over HTTP: `POST /api/escalations/run` (add `?dryRun=true` to preview).

If you already loaded demo data in an earlier week, delete `data/dev.sqlite3`
and run migrate, seed, demo again to get the updated sample timeline.

| Variable                       | Default | Meaning                                                  |
| ------------------------------ | ------- | -------------------------------------------------------- |
| `SLA_AT_RISK_PERCENT`          | 80      | Share of the target used before an incident is "at risk" |
| `ESCALATION_THRESHOLD_PERCENT` | 75      | Share of the current priority's target before escalating |
| `ESCALATION_ENABLED`           | true    | Run the automatic job inside the server                  |
| `ESCALATION_INTERVAL_SECONDS`  | 60      | How often the job runs                                   |

### Dashboard changes

The SLA column now uses the server's evaluation, so it agrees with the API: it
shows "Paused (on hold)", "Breached by 2h", "Breached · on hold", and so on.
Escalated incidents carry a "↑ from P3" tag, the summary card reads "SLA
breached", and the detail view shows the response SLA, time on hold, and the
escalation history.

### Known limits

- The job assumes **one server instance**. The re-check inside each transaction
  guards against stale reads, but running several instances would need a row
  lock or compare-and-swap update.
- Escalation is automatic only. There is no manual "raise priority" action yet,
  although `incident_escalations.escalated_by` is ready for one.
- No notifications are sent when an incident escalates or breaches (next step).
- "First response" means first assignment. If you would rather count the first
  move to `in_progress`, that is a one-line change in `slaService.loadSlaContext`.
- The hold calculation relies on status-history timestamps. If two history rows
  ever share the exact same millisecond, the safe fallback loses that pause
  rather than freezing a clock.

## Week 7 — lifecycle tests

The incident lifecycle (`new → assigned → in_progress → on_hold → resolved → closed`,
plus `cancelled` and reopening) is the core rule set of the app, so it now has three
layers of tests, each answering a different question.

| File                            | Layer          | Tests | What it proves                                                                                                                                                                                                                                                       |
| ------------------------------- | -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle.domain.test.js`      | Unit           | 139   | The rules themselves, with no database: the transition table, the 49 from/to pairs, status meanings, how `resolved_at`/`closed_at` are set and cleared, and that the database constraint, dashboard, SLA and escalation code all agree about what each status means  |
| `lifecycle.transitions.test.js` | Integration    | 122   | Everything through the real HTTP API and database: all 49 pairs, ten whole journeys, exact timestamps, history rows, input validation, assignment rules, rollback on failure, double submits, and how the lifecycle feeds the SLA and escalation                     |
| `lifecycle.invariants.test.js`  | Property-style | 202   | 200 seeded random journeys mixing legal and illegal moves. After every step it checks 8 invariants (history is a gap-free chain ending at the current status, timestamps match history, anything past `new` has an assignee, exactly one open assignment, and so on) |

```bash
npm test                  # everything (10 suites, 601 tests)
npm run test:coverage     # the same, with coverage and thresholds for the lifecycle code
npx jest tests/lifecycle  # just the lifecycle tests
```

### How the tests are built

- **The rules are written out twice, on purpose.** `tests/helpers/lifecycleSpec.js` holds
  the expected transition table independently of the code. The domain tests prove the code
  matches it; the other tests use it as their oracle. To change a rule deliberately,
  change it in both places, and the failing tests list everything that depends on it.
- **A controllable clock.** `src/utils/clock.js` is the app's source of "now" for
  lifecycle timestamps. Tests swap it so each step gets an exact, distinct time. That
  means assertions like "`resolved_at` equals the moment of the resolve" are exact, and
  there is no sleeping and no flaky ordering when two steps share a millisecond.
- **Rejected requests leave no trace.** Every rejected transition is checked against a
  before/after snapshot of the incident, its history and its assignments.
- **Seeded randomness.** The random walks use fixed seeds, so a failure is reproducible.
  The failure message names the seed and lists every action taken. A final check
  confirms the walks tried all 49 status moves and assignment in all 7 statuses, so they
  can't quietly stop exploring.
- **Atomicity is tested by breaking the database.** A table is taken offline mid-test so
  the last write of a transition fails; the test then checks the earlier writes were rolled back.

### Are the tests any good? A mutation check

Passing tests only matter if they fail when the code is wrong. The code was deliberately
broken in 20 different ways, one at a time (an allowed transition removed, a timestamp
never set, reopening not clearing `resolved_at`, no rollback on failure, a wrong deadline,
and so on), and the lifecycle tests were run against each. **All 20 were caught.**

### Coverage

| File                          | Statements | Branches |
| ----------------------------- | ---------- | -------- |
| `domain/incidentLifecycle.js` | 100%       | 100%     |
| `services/incidentService.js` | 100%       | 98.5%    |
| `domain/escalationPolicy.js`  | 100%       | 96.8%    |
| `domain/slaCalculator.js`     | 100%       | 95.7%    |

`npm run test:coverage` enforces floors on the domain folder and `incidentService.js`.
The Postgres paths in `config/database.js` are not covered, because they need a real Postgres server.

### A bug the tests found

Writing the tests exposed a real gap: `PATCH /api/incidents/:id/status` accepted
`new → assigned`, because that move is in the transition table. Nothing checked there was
an assignee, so an incident could go `new → assigned → in_progress → resolved` with
**nobody ever assigned and no assignment record**. The dashboard then showed an
"assigned" incident as "Unassigned", and the response SLA read it as never responded to.

It now returns 409 and points to the assignment endpoint. The fix is a single check in
`updateStatus`, and the random walks catch its removal on their own.

### Small changes made for testability

Both are behavior-preserving; the existing suite passed unchanged after each.

- The pure lifecycle rules moved from `incidentService.js` into
  `domain/incidentLifecycle.js` so they can be unit-tested without a database. The service
  still exports `ALLOWED_STATUSES` and `ALLOWED_TRANSITIONS` under their old names.
- Lifecycle timestamps now come from `utils/clock.js` instead of calling `new Date()` directly.

### Open questions (shown as `todo` in the test output)

These are decisions not made yet, so the tests deliberately don't pin them:

- **Reopen window.** The Week 1 design said a closed incident should only be reopenable
  within a set number of days. Not implemented: today it can always be reopened.
- **Reassigning a resolved incident** is currently allowed. Is that intended?
- **SLA between resolution and reopen.** The clock currently keeps running while an
  incident sits resolved. Should it pause?
- **Concurrent transitions on Postgres** need a row lock (`SELECT ... FOR UPDATE`). SQLite
  processes requests one at a time, so the simultaneous-request tests pass there; this can't
  be verified without a Postgres instance.

## Next weeks

Notifications on escalation and breach, create/assign/resolve actions from the
UI, and authentication/authorization on top of the `users.role` column that's
already in the schema.
