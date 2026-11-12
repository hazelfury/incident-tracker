# Code Review: Real-Time Incident Tracking & Service Desk Management System

Week 8: cross-functional code review and clean-code refactor.

## Scope and method

Every layer was reviewed: domain rules, services, controllers/routes/middleware, database and configuration, CLI scripts, the dashboard front end (JS, HTML, CSS) and the tests.

Each finding has a severity and a status:

- **Fixed**: changed in this refactor.
- **Deferred**: real, but out of scope for this week (reason given).
- **Accepted**: a conscious trade-off.
- **No change**: reviewed and good as is.

The refactor was done in small commits, with the test suite run after each one.

## Summary

- Business rules now have one source of truth (`domain/incidentLifecycle.js`); the service no longer keeps its own copy.
- Duplicated query, SQL-placeholder, status-history and CLI boilerplate code was extracted into single helpers.
- Time is read from one injectable clock everywhere in the request path; the pure domain layer no longer defaults to the real clock.
- Long functions were split (`runEscalationCycle`, `dueInfo`).
- Scripts now always close the database, including on failure.
- Security and robustness gaps that are out of scope are listed as deferred, not hidden.

## Findings

### Domain and services

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 1 | High | `incidentService.js`, `domain/incidentLifecycle.js` | The service re-declared the status list, transition table, can-assign rule, reopen rule and `resolved_at`/`closed_at` logic that the tested domain module already owns. | Fixed: the service calls the domain module |
| 5 | Medium | `incidentService.js` | The `incident_status_history` insert was repeated three times. | Fixed: `recordStatusChange` |
| 7 | Low | `incidentService.js` | `rowExists` spliced a table name into SQL, and treated "optional id not given" and "required id" the same way. | Fixed: table allowlist, intent documented |
| 8 | Low | `incidentService.js` | Magic number `60000`. | Fixed: uses `MINUTE_MS` |
| 9 | Low | services | Services throw `HttpError`, which couples business logic to HTTP. | Accepted: fine at this size |
| 16 | Medium | `slaCalculator.js`, `escalationPolicy.js` | The header says "no clock of its own", but `now = new Date()` defaults existed (the two uncovered branches in the coverage report). | Fixed: `now` is required |
| 17 | Medium | `slaCalculator.js`, `escalationPolicy.js` | Status groups (`FINISHED_STATUSES`, `ESCALATABLE_STATUSES`) were re-declared outside the lifecycle module. | Fixed: derived from the lifecycle module |
| 18 | Low | services, dashboard | The ms-per-minute constant existed in three forms. | Fixed |
| 19 | Medium | `escalationService.js` | `runEscalationCycle` mixed loading, deciding and persisting in one ~90-line function. | Fixed: `loadCandidates`, `evaluateIncident`, `applyEscalation` |
| 20 | Medium | `slaService.js` | Three context queries ran one after another, and one used a subquery that scanned the whole history table. | Fixed: parallel queries, plain `IN` query, filtered in JS |
| 21 | Low | services | The `IN (?, ?, …)` list was built by hand in three places. | Fixed: `utils/sql.js` |
| 28 | Medium | `escalationService.js` | The cycle loads every open incident and builds an `IN` list of unbounded size. | Deferred: batch it before production scale |
| 36 | Low | `lookupService.js`, `slaService.js` | The priorities query existed twice. | Fixed: `slaService` delegates to `lookupService` |
| 37 | Info | `escalationsController.js` | Thin and clear. | No change |

### Database, configuration and middleware

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 2 | High | `database.js` | SQLite shares one connection, so overlapping `withTransaction` calls could issue `BEGIN` inside another transaction. Currently masked because every await resolves in the same tick, but any real async work inside a callback would break it. | Fixed (defensive): transactions queue on SQLite. Add an overlap test |
| 3 | Medium | `database.js` | The prepare/select-or-run block was duplicated in `query()` and the transaction helper. | Fixed: `runSqlite`, `runPg` |
| 4 | Medium | `database.js` | `isSelect` was a regex that misclassified `WITH … SELECT` and `RETURNING` statements. | Fixed: uses `stmt.reader` |
| 10 | Low | `database.js` | `env.dbClient === "postgres"` was re-checked in six places. | Fixed: `usePostgres()` |
| 22 | Low | `env.js` | Numeric settings mixed a guarded helper with bare `parseInt` (`PORT=abc` gave `NaN`). | Fixed: `int()` helper |
| 25 | Medium | `app.js`, `env.js` | CORS defaults to `*`, and the urlencoded parser is on although the API takes JSON. | Deferred: require `CORS_ORIGIN` in production, drop the parser if unused |
| 26 | Medium | controllers | Body fields are forwarded unchecked, so a wrongly typed field becomes a driver error (500) instead of a 400. | Deferred: add schema validation |
| 31 | Info | `errorHandler.js`, `requestLogger.js` | Operational vs unexpected errors handled correctly; stack hidden in production. | No change |
| 32 | Info | `escalationJob.js`, `server.js` | Overlapping runs skipped, timer unref'd, `stop()` waits for the in-flight run, graceful shutdown. | No change |

### Security

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 6 | Medium | `incidentsController.js` | `assignedBy` and `changedBy` come from the request body, so the audit trail can be forged. | Accepted for coursework scope: take identity from `req.user` once auth exists |
| 27 | High | `routes/escalations.js` | `POST /api/escalations/run` changes priorities and has no authentication. | Accepted for coursework scope: add auth before any real deployment |

### Scripts

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 13 | Medium | `migrate.js`, `seed.js`, `run-escalation.js`, `seed-demo.js` | On failure the database was never closed, so a Postgres pool would keep the process hanging. | Fixed: `scripts/lib/runCli.js` closes in `finally` |
| 14 | Low | same scripts | Repeated init/run/catch boilerplate, and a redundant `dotenv.config()` (`env.js` already loads it). | Fixed |
| 15 | Low | `seed.js` | `upsert*` helpers only insert when missing. | Fixed: renamed `ensure*` |
| 38 | Low | `seed-demo.js` | Magic numbers `3600000`, `60000`. | Fixed |
| 39 | Medium | `seed-demo.js` | `retime()` rewrites timestamps after the fact and `sleep(3)` keeps ordering distinct. The injectable clock (`clock.setSource`) could produce the right timestamps directly. | Deferred: recommended redesign; it needs careful re-verification of the demo data |

### Front end

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 23 | Medium | `dashboard-utils.js` | `dueInfo` was a ~45-line function with two parallel paths and a repeated "no info" object. | Fixed: `dueInfoFromSla`, `dueInfoFromDueAt`, `noInfo()` |
| 24 | Low | `dashboard-utils.js` | Sorting used the stored `due_at` while the column shows the pause-adjusted date. | Fixed: `effectiveDueDate` |
| 17b | Medium | `dashboard-utils.js` | The status lists mirror the backend lifecycle and could drift apart. | Fixed: sync tests in `dashboardUtils.test.js` |
| 29 | Info | `dashboard-utils.js`, `slaCalculator.js` | Date parsing (including SQLite's zone-less format) exists on both sides; the browser can't import the backend. | Accepted |
| 40 | Low | `public/js/app.js` | `openDetails` doesn't ignore stale responses: opening incident A then B quickly can show A's details. | Fixed: request counter guard |
| 41 | Low | `public/js/app.js` | Auto-refresh keeps polling in a hidden tab. | Fixed: skip while `document.hidden`, refresh on return |
| 42 | Low | `public/js/app.js` | `renderDetails` repeats the same "timeline list or empty message" block three times; `60000` is a magic number in `renderLegend`. | Fixed: `renderTimeline` helper, named constant |
| 43 | Low | `public/js/app.js` | The search box re-renders on every keystroke. Fine at the 500-row cap. | Deferred: debounce if the list grows |
| 44 | Info | `public/js/app.js` | The DOM layer has no automated tests. | Deferred: add jsdom tests |
| 45 | Info | `app.js` (front end), `index.html`, `styles.css` | Text always goes in through text nodes (no `innerHTML`), keyboard focus is restored after re-render, landmarks/ARIA/labelled dialog are correct, design tokens, dark mode, reduced motion and a card layout for small screens. | No change |

## Verification

Run before submitting, and record the results here:

```
npm test
npm run test:coverage
npm run lint
npm run format:check
```

- Tests: _N suites, N tests, all passing_
- Coverage: _overall % statements / % branches; `src/domain/` and `incidentService.js` gates met_
- Lint: _0 errors_

## Follow-ups

1. Authentication and authorization (findings 6, 26, 27).
2. Request validation layer (finding 26).
3. Postgres test run (database.js is mostly SQLite-tested).
4. Notifications on breach and escalation.
5. jsdom tests for the dashboard DOM layer (finding 44).