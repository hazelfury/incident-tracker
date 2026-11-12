const crypto = require("crypto");
const db = require("../config/database");
const { HttpError } = require("../utils/httpError");
const clock = require("../utils/clock");
const { placeholders } = require("../utils/sql");
const lifecycle = require("../domain/incidentLifecycle");
const { MINUTE_MS } = require("../domain/slaCalculator");
const slaService = require("./slaService");

const LIST_LIMIT = 500;

// Tables that rowExists() is allowed to look in. The table name is spliced
// into the SQL text (it can't be a bound parameter), so it must never come
// from anything but this list.
const REFERENCE_TABLES = new Set(["users", "categories", "teams"]);

function nowIso() {
  return clock.now().toISOString();
}

/**
 * Checks that a referenced row exists. An empty id means "optional foreign
 * key not provided", which is treated as valid: required fields must be
 * checked for presence by the caller.
 */
async function rowExists(table, id) {
  if (!REFERENCE_TABLES.has(table)) {
    throw new Error(`rowExists: unexpected table "${table}"`);
  }
  if (!id) return true;
  const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE id = ?`, [id]);
  return rows.length > 0;
}

async function fetchIncident(query, id) {
  const { rows } = await query("SELECT * FROM incidents WHERE id = ?", [id]);
  return rows[0] || null;
}

// The single place a status_history row is written, so every transition is
// logged the same way. `from` is null for an incident's first row.
function recordStatusChange(query, { incidentId, from, to, changedBy, changedAt, note = null }) {
  return query(
    `INSERT INTO incident_status_history
       (id, incident_id, from_status, to_status, changed_by, changed_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), incidentId, from, to, changedBy || null, changedAt, note]
  );
}

/**
 * Creates an incident in the "new" state, computing due_at from the chosen
 * priority's SLA, and logs the initial status history row in the same
 * transaction as the insert.
 */
async function createIncident({ title, description, reporterId, categoryId, priorityId, teamId }) {
  if (!title || !reporterId || !categoryId || !priorityId) {
    throw new HttpError(400, "title, reporterId, categoryId, and priorityId are required");
  }

  const priorityResult = await db.query(
    "SELECT sla_resolution_mins FROM priorities WHERE id = ?",
    [priorityId]
  );
  if (!priorityResult.rows.length) {
    throw new HttpError(400, `Unknown priorityId: ${priorityId}`);
  }
  if (!(await rowExists("users", reporterId))) {
    throw new HttpError(400, `Unknown reporterId: ${reporterId}`);
  }
  if (!(await rowExists("categories", categoryId))) {
    throw new HttpError(400, `Unknown categoryId: ${categoryId}`);
  }
  if (!(await rowExists("teams", teamId))) {
    throw new HttpError(400, `Unknown teamId: ${teamId}`);
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const slaMins = priorityResult.rows[0].sla_resolution_mins;
  // Derived from createdAt so the two timestamps can never drift apart.
  const dueAt = new Date(Date.parse(createdAt) + slaMins * MINUTE_MS).toISOString();

  return db.withTransaction(async (query) => {
    await query(
      `INSERT INTO incidents
         (id, title, description, status, reporter_id, team_id, category_id, priority_id, created_at, due_at)
       VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
      [id, title, description || null, reporterId, teamId || null, categoryId, priorityId, createdAt, dueAt]
    );
    await recordStatusChange(query, {
      incidentId: id,
      from: null,
      to: "new",
      changedBy: reporterId,
      changedAt: createdAt,
    });
    return fetchIncident(query, id);
  });
}

/**
 * Assigns (or reassigns) an incident to a user. Closes out any currently
 * open incident_assignments row, opens a new one, updates incidents.assignee_id,
 * and, if the incident is still "new", advances status to "assigned" with
 * a matching status history row. All in one transaction.
 */
async function assignIncident({ incidentId, assignedTo, assignedBy, reason }) {
  if (!assignedTo) {
    throw new HttpError(400, "assignedTo is required");
  }
  if (!(await rowExists("users", assignedTo))) {
    throw new HttpError(400, `Unknown assignedTo: ${assignedTo}`);
  }
  if (!(await rowExists("users", assignedBy))) {
    throw new HttpError(400, `Unknown assignedBy: ${assignedBy}`);
  }

  return db.withTransaction(async (query) => {
    const incident = await fetchIncident(query, incidentId);
    if (!incident) {
      throw new HttpError(404, `Incident not found: ${incidentId}`);
    }
    if (!lifecycle.canAssign(incident.status)) {
      throw new HttpError(
        409,
        `Cannot assign an incident with status "${incident.status}"`
      );
    }

    const assignedAt = nowIso();

    await query(
      `UPDATE incident_assignments SET unassigned_at = ?
       WHERE incident_id = ? AND unassigned_at IS NULL`,
      [assignedAt, incidentId]
    );
    await query(
      `INSERT INTO incident_assignments (id, incident_id, assigned_to, assigned_by, assigned_at, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), incidentId, assignedTo, assignedBy || null, assignedAt, reason || null]
    );

    const nextStatus = lifecycle.statusAfterAssignment(incident.status);

    await query(
      `UPDATE incidents SET assignee_id = ?, assigned_at = ?, status = ? WHERE id = ?`,
      [assignedTo, assignedAt, nextStatus, incidentId]
    );

    if (nextStatus !== incident.status) {
      await recordStatusChange(query, {
        incidentId,
        from: incident.status,
        to: nextStatus,
        changedBy: assignedBy,
        changedAt: assignedAt,
      });
    }

    return fetchIncident(query, incidentId);
  });
}

/**
 * Transitions an incident's status, validating against the lifecycle rules,
 * stamping resolved_at / closed_at as appropriate, and logging the change
 * to incident_status_history. Moving to "assigned" is not allowed here: only
 * the assignment endpoint may do that, because it also sets the assignee.
 */
async function updateStatus({ incidentId, toStatus, changedBy, note }) {
  if (!lifecycle.isValidStatus(toStatus)) {
    throw new HttpError(
      400,
      `Invalid status "${toStatus}". Must be one of: ${lifecycle.STATUSES.join(", ")}`
    );
  }
  if (!(await rowExists("users", changedBy))) {
    throw new HttpError(400, `Unknown changedBy: ${changedBy}`);
  }

  return db.withTransaction(async (query) => {
    const incident = await fetchIncident(query, incidentId);
    if (!incident) {
      throw new HttpError(404, `Incident not found: ${incidentId}`);
    }

    if (!lifecycle.canTransition(incident.status, toStatus)) {
      const allowedNext = lifecycle.allowedNext(incident.status);
      throw new HttpError(
        409,
        `Cannot move incident from "${incident.status}" to "${toStatus}". ` +
          `Allowed next states: ${allowedNext.length ? allowedNext.join(", ") : "none (terminal state)"}`
      );
    }

    if (toStatus === "assigned") {
      throw new HttpError(
        409,
        `Cannot move incident to "assigned" without an assignee. ` +
          `Use the assignment endpoint, which sets the assignee and the status together`
      );
    }

    const changedAt = nowIso();
    const { resolved_at, closed_at } = lifecycle.timestampsForTransition({
      from: incident.status,
      to: toStatus,
      now: changedAt,
      resolved_at: incident.resolved_at,
      closed_at: incident.closed_at,
    });

    await query(
      `UPDATE incidents SET status = ?, resolved_at = ?, closed_at = ? WHERE id = ?`,
      [toStatus, resolved_at, closed_at, incidentId]
    );
    await recordStatusChange(query, {
      incidentId,
      from: incident.status,
      to: toStatus,
      changedBy,
      changedAt,
      note: note || null,
    });

    return fetchIncident(query, incidentId);
  });
}

// Read model for the dashboard: the incident row plus the human-readable
// names the UI needs (priority, category, team, assignee, reporter), so the
// front-end doesn't have to make a lookup request per row.
const INCIDENT_SELECT = `
  SELECT i.*,
         p.name  AS priority_name,
         p.level AS priority_level,
         c.name  AS category_name,
         t.name  AS team_name,
         a.name  AS assignee_name,
         r.name  AS reporter_name
  FROM incidents i
  JOIN priorities p ON p.id = i.priority_id
  LEFT JOIN categories c ON c.id = i.category_id
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN users a ON a.id = i.assignee_id
  LEFT JOIN users r ON r.id = i.reporter_id`;

async function getIncidentById(id) {
  const { rows } = await db.query(`${INCIDENT_SELECT} WHERE i.id = ?`, [id]);
  if (!rows.length) {
    throw new HttpError(404, `Incident not found: ${id}`);
  }
  const assignments = await db.query(
    `SELECT ia.*, u.name AS assigned_to_name, b.name AS assigned_by_name
     FROM incident_assignments ia
     JOIN users u ON u.id = ia.assigned_to
     LEFT JOIN users b ON b.id = ia.assigned_by
     WHERE ia.incident_id = ?
     ORDER BY ia.assigned_at`,
    [id]
  );
  const statusHistory = await db.query(
    `SELECT h.*, u.name AS changed_by_name
     FROM incident_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.incident_id = ?
     ORDER BY h.changed_at`,
    [id]
  );
  const escalations = await db.query(
    `SELECT e.*,
            pf.name  AS from_priority_name,
            pf.level AS from_priority_level,
            pt.name  AS to_priority_name,
            pt.level AS to_priority_level,
            u.name   AS escalated_by_name
     FROM incident_escalations e
     JOIN priorities pf ON pf.id = e.from_priority_id
     JOIN priorities pt ON pt.id = e.to_priority_id
     LEFT JOIN users u ON u.id = e.escalated_by
     WHERE e.incident_id = ?
     ORDER BY e.escalated_at`,
    [id]
  );
  const [withSla] = await slaService.attachSla([rows[0]]);
  return {
    ...withSla,
    assignments: assignments.rows,
    statusHistory: statusHistory.rows,
    escalations: escalations.rows,
  };
}

/**
 * Lists incidents (most urgent first), optionally filtered by status.
 * `status` may be one status or a comma-separated list, e.g. "new,assigned".
 * Capped at LIST_LIMIT rows until pagination is added.
 */
async function listIncidents({ status } = {}) {
  const params = [];
  let where = "";

  const statuses = String(status || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (statuses.length) {
    const invalid = statuses.filter((s) => !lifecycle.isValidStatus(s));
    if (invalid.length) {
      throw new HttpError(
        400,
        `Invalid status filter: ${invalid.join(", ")}. Must be one of: ${lifecycle.STATUSES.join(", ")}`
      );
    }
    where = ` WHERE i.status IN ${placeholders(statuses.length)}`;
    params.push(...statuses);
  }

  const { rows } = await db.query(
    `${INCIDENT_SELECT}${where} ORDER BY p.level ASC, i.created_at DESC LIMIT ${LIST_LIMIT}`,
    params
  );
  return slaService.attachSla(rows);
}

module.exports = {
  // Kept as aliases so existing imports keep working; the source of truth is
  // domain/incidentLifecycle.js.
  ALLOWED_STATUSES: lifecycle.STATUSES,
  ALLOWED_TRANSITIONS: lifecycle.TRANSITIONS,
  createIncident,
  assignIncident,
  updateStatus,
  getIncidentById,
  listIncidents,
};