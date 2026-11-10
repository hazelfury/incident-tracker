const db = require("../config/database");
const env = require("../config/env");
const { evaluateSla } = require("../domain/slaCalculator");
const clock = require("../utils/clock");

const PRIORITY_COLUMNS = "id, name, level, sla_response_mins, sla_resolution_mins";

function inClause(ids) {
  return `(${ids.map(() => "?").join(", ")})`;
}

async function loadPriorities() {
  const { rows } = await db.query(`SELECT ${PRIORITY_COLUMNS} FROM priorities ORDER BY level ASC`);
  return rows; // most urgent first
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

/**
 * Loads, for a set of incidents, everything the SLA calculation needs beyond
 * the incident row itself. Three queries total no matter how many incidents,
 * so listing 500 incidents doesn't mean 1,500 round trips.
 *
 *   historyByIncident         on-hold history rows (only incidents that have
 *                             ever been on hold appear here)
 *   firstResponseByIncident   earliest assignment time per incident
 *   escalationsByIncident     escalation rows, oldest first
 */
async function loadSlaContext(incidentIds) {
  const ctx = {
    historyByIncident: new Map(),
    firstResponseByIncident: new Map(),
    escalationsByIncident: new Map(),
  };
  if (!incidentIds.length) return ctx;

  const ids = inClause(incidentIds);

  const history = await db.query(
    `SELECT incident_id, to_status, changed_at
       FROM incident_status_history
      WHERE incident_id IN ${ids}
        AND incident_id IN (SELECT incident_id FROM incident_status_history WHERE to_status = 'on_hold')
      ORDER BY changed_at`,
    incidentIds
  );
  ctx.historyByIncident = groupBy(history.rows, "incident_id");

  const firstResponse = await db.query(
    `SELECT incident_id, MIN(assigned_at) AS first_response_at
       FROM incident_assignments
      WHERE incident_id IN ${ids}
      GROUP BY incident_id`,
    incidentIds
  );
  for (const row of firstResponse.rows) {
    ctx.firstResponseByIncident.set(row.incident_id, row.first_response_at);
  }

  const escalations = await db.query(
    `SELECT incident_id, from_priority_id, escalated_at
       FROM incident_escalations
      WHERE incident_id IN ${ids}
      ORDER BY escalated_at`,
    incidentIds
  );
  ctx.escalationsByIncident = groupBy(escalations.rows, "incident_id");

  return ctx;
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
