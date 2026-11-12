const db = require("../config/database");
const env = require("../config/env");
const { evaluateSla } = require("../domain/slaCalculator");
const clock = require("../utils/clock");
const { placeholders } = require("../utils/sql");
const { listPriorities } = require("./lookupService");

// Priorities, most urgent first. The query lives in lookupService; this alias
// keeps the name escalationService and the SLA code already import.
const loadPriorities = listPriorities;

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

// Only incidents that have ever been on hold matter to the SLA clock. For
// those we keep every history row, because a hold ends at the row after it.
function groupHoldHistory(historyRows) {
  const byIncident = groupBy(historyRows, "incident_id");
  for (const [incidentId, rows] of byIncident) {
    if (!rows.some((row) => row.to_status === "on_hold")) byIncident.delete(incidentId);
  }
  return byIncident;
}

/**
 * Loads, for a set of incidents, everything the SLA calculation needs beyond
 * the incident row itself. Three queries total no matter how many incidents,
 * so listing 500 incidents doesn't mean 1,500 round trips.
 *
 *   historyByIncident         status history (only incidents that have ever
 *                             been on hold appear here)
 *   firstResponseByIncident   earliest assignment time per incident
 *   escalationsByIncident     escalation rows, oldest first
 */
async function loadSlaContext(incidentIds) {
  if (!incidentIds.length) {
    return {
      historyByIncident: new Map(),
      firstResponseByIncident: new Map(),
      escalationsByIncident: new Map(),
    };
  }

  const ids = placeholders(incidentIds.length);

  const [history, firstResponse, escalations] = await Promise.all([
    db.query(
      `SELECT incident_id, to_status, changed_at
         FROM incident_status_history
        WHERE incident_id IN ${ids}
        ORDER BY changed_at`,
      incidentIds
    ),
    db.query(
      `SELECT incident_id, MIN(assigned_at) AS first_response_at
         FROM incident_assignments
        WHERE incident_id IN ${ids}
        GROUP BY incident_id`,
      incidentIds
    ),
    db.query(
      `SELECT incident_id, from_priority_id, escalated_at
         FROM incident_escalations
        WHERE incident_id IN ${ids}
        ORDER BY escalated_at`,
      incidentIds
    ),
  ]);

  return {
    historyByIncident: groupHoldHistory(history.rows),
    firstResponseByIncident: new Map(
      firstResponse.rows.map((row) => [row.incident_id, row.first_response_at])
    ),
    escalationsByIncident: groupBy(escalations.rows, "incident_id"),
  };
}

/**
 * Adds to each incident row:
 *   sla                    resolution + response SLA evaluation (see slaCalculator)
 *   escalation_count       how many times its priority has been raised
 *   original_priority_name the priority it started at, or null if never escalated
 *
 * The response SLA is judged against the priority the incident was created
 * with, so an escalation can't retroactively turn a met response SLA into a
 * breached one.
 */
async function attachSla(rows, now = clock.now()) {
  if (!rows.length) return rows;

  const priorities = await loadPriorities();
  const priorityById = new Map(priorities.map((p) => [p.id, p]));
  const ctx = await loadSlaContext(rows.map((r) => r.id));

  return rows.map((row) => {
    const escalations = ctx.escalationsByIncident.get(row.id) || [];
    const originalPriorityId = escalations.length ? escalations[0].from_priority_id : row.priority_id;
    const original = priorityById.get(originalPriorityId);

    const sla = evaluateSla({
      incident: row,
      responseTargetMins: original ? original.sla_response_mins : null,
      history: ctx.historyByIncident.get(row.id) || [],
      firstResponseAt: ctx.firstResponseByIncident.get(row.id) || null,
      now,
      atRiskPercent: env.slaAtRiskPercent,
    });

    return {
      ...row,
      sla,
      escalation_count: escalations.length,
      original_priority_name: escalations.length && original ? original.name : null,
    };
  });
}

module.exports = { loadPriorities, loadSlaContext, attachSla };