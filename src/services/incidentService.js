const crypto = require("crypto");
const db = require("../config/database");
const { HttpError } = require("../utils/httpError");

const ALLOWED_STATUSES = [
  "new",
  "assigned",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "cancelled",
];

// Which statuses an incident may move to from its current one. Mirrors the
// Week 1 lifecycle design: New -> Assigned -> In progress -> Resolved ->
// Closed, with On hold / Cancelled / Reopen branches.
const ALLOWED_TRANSITIONS = {
  new: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["on_hold", "resolved", "cancelled"],
  on_hold: ["in_progress"],
  resolved: ["closed", "in_progress"], // reopen straight from resolved
  closed: ["in_progress"], // reopened
  cancelled: [],
};

function nowIso() {
  return new Date().toISOString();
}

async function rowExists(table, id) {
  if (!id) return true; // optional FK — nothing to check
  const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE id = ?`, [id]);
  return rows.length > 0;
}

async function fetchIncident(query, id) {
  const { rows } = await query("SELECT * FROM incidents WHERE id = ?", [id]);
  return rows[0] || null;
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
  const dueAt = new Date(Date.now() + slaMins * 60000).toISOString();

  return db.withTransaction(async (query) => {
    await query(
      `INSERT INTO incidents
         (id, title, description, status, reporter_id, team_id, category_id, priority_id, created_at, due_at)
       VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
      [id, title, description || null, reporterId, teamId || null, categoryId, priorityId, createdAt, dueAt]
    );
    await query(
      `INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, changed_at)
       VALUES (?, ?, NULL, 'new', ?, ?)`,
      [crypto.randomUUID(), id, reporterId, createdAt]
    );
    return fetchIncident(query, id);
  });
}

/**
 * Assigns (or reassigns) an incident to a user. Closes out any currently
 * open incident_assignments row, opens a new one, updates incidents.assignee_id,
 * and — if the incident is still "new" — advances status to "assigned" with
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
    if (incident.status === "cancelled" || incident.status === "closed") {
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

    const nextStatus = incident.status === "new" ? "assigned" : incident.status;

    await query(
      `UPDATE incidents SET assignee_id = ?, assigned_at = ?, status = ? WHERE id = ?`,
      [assignedTo, assignedAt, nextStatus, incidentId]
    );

    if (nextStatus !== incident.status) {
      await query(
        `INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), incidentId, incident.status, nextStatus, assignedBy || null, assignedAt]
      );
    }

    return fetchIncident(query, incidentId);
  });
}

/**
 * Transitions an incident's status, validating against ALLOWED_TRANSITIONS,
 * stamping resolved_at / closed_at as appropriate, and logging the change
 * to incident_status_history. This is also where resolution timestamps get
 * set — resolved_at the moment status becomes "resolved", closed_at the
 * moment it becomes "closed", both cleared again on reopen.
 */
async function updateStatus({ incidentId, toStatus, changedBy, note }) {
  if (!ALLOWED_STATUSES.includes(toStatus)) {
    throw new HttpError(
      400,
      `Invalid status "${toStatus}". Must be one of: ${ALLOWED_STATUSES.join(", ")}`
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

    const allowedNext = ALLOWED_TRANSITIONS[incident.status] || [];
    if (!allowedNext.includes(toStatus)) {
      throw new HttpError(
        409,
        `Cannot move incident from "${incident.status}" to "${toStatus}". ` +
          `Allowed next states: ${allowedNext.length ? allowedNext.join(", ") : "none (terminal state)"}`
      );
    }

    const changedAt = nowIso();
    const reopening = toStatus === "in_progress" && ["resolved", "closed"].includes(incident.status);

    const resolvedAt = toStatus === "resolved" ? changedAt : reopening ? null : incident.resolved_at;
    const closedAt = toStatus === "closed" ? changedAt : reopening ? null : incident.closed_at;

    await query(
      `UPDATE incidents SET status = ?, resolved_at = ?, closed_at = ? WHERE id = ?`,
      [toStatus, resolvedAt, closedAt, incidentId]
    );
    await query(
      `INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, changed_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), incidentId, incident.status, toStatus, changedBy || null, changedAt, note || null]
    );

    return fetchIncident(query, incidentId);
  });
}

async function getIncidentById(id) {
  const { rows } = await db.query("SELECT * FROM incidents WHERE id = ?", [id]);
  if (!rows.length) {
    throw new HttpError(404, `Incident not found: ${id}`);
  }
  const assignments = await db.query(
    "SELECT * FROM incident_assignments WHERE incident_id = ? ORDER BY assigned_at",
    [id]
  );
  const statusHistory = await db.query(
    "SELECT * FROM incident_status_history WHERE incident_id = ? ORDER BY changed_at",
    [id]
  );
  return { ...rows[0], assignments: assignments.rows, statusHistory: statusHistory.rows };
}

async function listIncidents() {
  const { rows } = await db.query("SELECT * FROM incidents ORDER BY created_at DESC");
  return rows;
}

module.exports = {
  ALLOWED_STATUSES,
  ALLOWED_TRANSITIONS,
  createIncident,
  assignIncident,
  updateStatus,
  getIncidentById,
  listIncidents,
};
