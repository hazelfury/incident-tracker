const crypto = require("crypto");
const db = require("../config/database");
const clock = require("../utils/clock");
const requestContext = require("../utils/requestContext");
const { HttpError } = require("../utils/httpError");
const { isValidAuditAction, AUDIT_ACTION_VALUES, compactMetadata } = require("../domain/auditPolicy");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Writes one audit row using the caller's `query` function.
 *
 * Pass the `query` handed out by db.withTransaction so the audit row commits
 * or rolls back together with the change it describes: an action can never
 * happen without its audit row, nor an audit row without its action. If the
 * insert fails, the whole transaction fails.
 *
 *   action       one of AUDIT_ACTIONS
 *   entityType   what was changed ("incident")
 *   entityId     which one
 *   incidentId   the incident it belongs to (for the per-incident trail)
 *   actorId      who did it; null = the system
 *   changes      { field: { from, to } }, see domain/auditPolicy.diffFields
 *   metadata     extra context (note, reason, ...). Request id, client address
 *                and user agent are added automatically inside a request.
 *   occurredAt   ISO string; defaults to the app clock
 *
 * This module deliberately has no update or delete function: the log is
 * append-only.
 */
function record(
  query,
  { action, entityType, entityId, incidentId = null, actorId = null, changes = null, metadata = null, occurredAt }
) {
  if (!isValidAuditAction(action)) {
    throw new Error(`auditService.record: unknown action "${action}"`);
  }
  const meta = compactMetadata(requestContext.get(), metadata);
  const hasChanges = changes && Object.keys(changes).length > 0;

  return query(
    `INSERT INTO audit_log
       (id, occurred_at, actor_id, action, entity_type, entity_id, incident_id, changes, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      occurredAt || clock.now().toISOString(),
      actorId,
      action,
      entityType,
      entityId,
      incidentId,
      hasChanges ? JSON.stringify(changes) : null,
      meta ? JSON.stringify(meta) : null,
    ]
  );
}

function parseJson(value) {
  return value ? JSON.parse(value) : null;
}

function toIsoOrThrow(value, name) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400, `Invalid ${name}: "${value}" is not a date`);
  return new Date(ms).toISOString();
}

function parseLimit(value) {
  if (value === undefined || value === "") return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new HttpError(400, `Invalid limit: must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  return n;
}

function parseOffset(value) {
  if (value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "Invalid offset: must be a whole number, 0 or more");
  return n;
}

/**
 * Reads the log, newest first by default.
 *
 * Filters: entityType, entityId, incidentId, actorId, action, from, to
 * (ISO dates, both inclusive), plus limit (default 50, max 200), offset and
 * order ("asc" | "desc").
 */
async function list({
  entityType,
  entityId,
  incidentId,
  actorId,
  action,
  from,
  to,
  limit,
  offset,
  order = "desc",
} = {}) {
  if (action !== undefined && action !== "" && !isValidAuditAction(action)) {
    throw new HttpError(400, `Invalid action "${action}". Must be one of: ${AUDIT_ACTION_VALUES.join(", ")}`);
  }
  if (order !== "asc" && order !== "desc") {
    throw new HttpError(400, 'Invalid order: must be "asc" or "desc"');
  }

  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    conditions.push(sql);
    params.push(value);
  };

  if (entityType) add("a.entity_type = ?", entityType);
  if (entityId) add("a.entity_id = ?", entityId);
  if (incidentId) add("a.incident_id = ?", incidentId);
  if (actorId) add("a.actor_id = ?", actorId);
  if (action) add("a.action = ?", action);
  if (from) add("a.occurred_at >= ?", toIsoOrThrow(from, "from"));
  if (to) add("a.occurred_at <= ?", toIsoOrThrow(to, "to"));

  const pageSize = parseLimit(limit);
  const skip = parseOffset(offset);
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const direction = order === "asc" ? "ASC" : "DESC";

  const { rows } = await db.query(
    `SELECT a.*, u.name AS actor_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id${where}
      ORDER BY a.occurred_at ${direction}
      LIMIT ? OFFSET ?`,
    [...params, pageSize, skip]
  );

  return {
    items: rows.map((row) => ({ ...row, changes: parseJson(row.changes), metadata: parseJson(row.metadata) })),
    limit: pageSize,
    offset: skip,
  };
}

/** One incident's trail, oldest first (the order it happened in). 404 if there is no such incident. */
async function listForIncident(incidentId, options = {}) {
  const { rows } = await db.query("SELECT 1 FROM incidents WHERE id = ?", [incidentId]);
  if (!rows.length) throw new HttpError(404, `Incident not found: ${incidentId}`);
  // `options.order` may be present but undefined (the controller passes it straight
  // from req.query), so default with || rather than relying on object spread.
  return list({ ...options, order: options.order || "asc", incidentId });
}

module.exports = { record, list, listForIncident };