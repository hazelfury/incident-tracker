# Week 10: Audit logging

Every action that changes an incident writes one row to the append-only `audit_log` table:
who did it, what changed (before and after), when, and from where.

## What is recorded

| Action                    | Written when                                   | `changes` (only fields that changed)        | `metadata`                         |
| ------------------------- | ---------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `incident.created`        | `POST /api/incidents`                          | title, status, reporter, team, category, priority, due_at (all `null -> value`) | request context |
| `incident.assigned`       | first assignment                               | status (`new -> assigned`), assignee_id     | `reason`                           |
| `incident.reassigned`     | assigning an incident that already has someone | assignee_id (status too if it changed)      | `reason`                           |
| `incident.status_changed` | `PATCH /api/incidents/:id/status`              | status, resolved_at, closed_at              | `note`                             |
| `incident.reopened`       | resolved/closed -> in_progress                 | status, resolved_at and closed_at cleared   | `note`                             |
| `incident.escalated`      | automatic escalation job (or manual run)       | priority_id                                 | `automatic`, priority names, `reason` |

Request context (`requestId`, `ip`, `userAgent`) is added to `metadata` automatically for anything done
through the API. Actions from scripts or the escalation timer have none of it. `actor_id` is `null` for the system.

Not recorded: rejected requests (400/404/409, nothing changed), and reads.

## Guarantees

- **Same transaction.** The audit row uses the transaction's own `query`, so an action and its audit row
  commit or roll back together. If the audit insert fails, the action fails (tests take the table offline to prove it).
- **Append-only at the app level.** `auditService` exports only `record`, `list` and `listForIncident`
  (a test enforces this). There is no database-level protection yet, see below.
- **Exact timestamps.** `occurred_at` equals the action's own timestamp (`resolved_at`, `assigned_at`, ...), not a second `now()`.

## API

| Method | Path                      | Notes                                                                  |
| ------ | ------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/audit-logs`         | Filters: `entityType`, `entityId`, `incidentId`, `actorId`, `action`, `from`, `to` (inclusive ISO dates). Paging: `limit` (1-200, default 50), `offset`. `order=asc\|desc` (default `desc`). |
| GET    | `/api/incidents/:id/audit` | One incident's trail, oldest first by default. 404 for an unknown incident. |

Response: `{ items: [...], limit, offset }`. Each item has `changes` and `metadata` already parsed, plus `actor_name`.
Invalid filters return 400. Every response carries an `X-Request-Id` header (a client-sent one is kept, trimmed to 100 chars).

## Files

- `src/domain/auditPolicy.js`: action names, tracked fields, `diffFields`, `compactMetadata` (pure)
- `src/services/auditService.js`: `record`, `list`, `listForIncident`
- `src/utils/requestContext.js`, `src/middleware/requestContext.js`: request id / ip / user agent via `AsyncLocalStorage`
- `src/controllers/auditController.js`, `src/routes/audit.js`: HTTP layer
- Changed: `incidentService.js`, `escalationService.js`, `app.js`, `routes/index.js`, `routes/incidents.js`, `database/schema.sql`
- Tests: `tests/auditPolicy.domain.test.js` (unit), `tests/audit.test.js` (integration)

## Known limits (deferred)

1. **Actor identity is client-supplied** (`reporterId`, `assignedBy`, `changedBy` come from the request body; finding 6).
   The log is only as trustworthy as that field until authentication exists. `ip` and `userAgent` are recorded as a second signal.
2. **Reads of `/api/audit-logs` are unauthenticated** (same gap as finding 27). Add a manager/admin role check with auth.
3. **No database-level immutability.** SQLite and Postgres need different `BEFORE UPDATE/DELETE` triggers, which breaks the
   "one schema.sql for both" rule. Do it per dialect, or revoke UPDATE/DELETE on `audit_log` for the app's Postgres role.
4. **Ordering ties.** Two rows in the same millisecond have no defined order. A monotonic sequence column would fix it.
5. **No retention or archiving policy** for `audit_log`.