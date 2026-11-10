const crypto = require("crypto");
const db = require("../config/database");
const env = require("../config/env");
const slaService = require("./slaService");
const clock = require("../utils/clock");
const {
  ESCALATABLE_STATUSES,
  findNextHigherPriority,
  decideEscalation,
} = require("../domain/escalationPolicy");

/**
 * One pass over all open incidents, raising any that are due by one priority
 * level (see domain/escalationPolicy.js for the rule).
 *
 *   now     override the clock (used by tests and scripts)
 *   dryRun  report what WOULD be escalated without changing anything
 *
 * Each escalation is its own transaction: the priority change and its audit
 * row are written together or not at all, and one failing incident doesn't
 * stop the rest. At most one level per incident per run.
 *
 * Assumes a single scheduler is running. Before the app runs as multiple
 * instances, the re-check inside the transaction below (which skips an incident
 * whose priority changed since it was read) should be backed by a row lock or
 * a compare-and-swap UPDATE.
 */
async function runEscalationCycle({ now = clock.now(), dryRun = false } = {}) {
  const priorities = await slaService.loadPriorities();
  const priorityById = new Map(priorities.map((p) => [p.id, p]));

  const { rows: candidates } = await db.query(
    `SELECT id, title, status, priority_id, created_at
       FROM incidents
      WHERE status IN (${ESCALATABLE_STATUSES.map(() => "?").join(", ")})`,
    ESCALATABLE_STATUSES
  );

  const ctx = await slaService.loadSlaContext(candidates.map((c) => c.id));

  const escalated = [];
  const errors = [];

  for (const incident of candidates) {
    const current = priorityById.get(incident.priority_id);
    if (!current) continue;

    const next = findNextHigherPriority(priorities, current);
    const past = ctx.escalationsByIncident.get(incident.id) || [];
    const lastEscalationAt = past.length ? past[past.length - 1].escalated_at : null;

    const decision = decideEscalation({
      incident,
      currentPriority: current,
      nextPriority: next,
      history: ctx.historyByIncident.get(incident.id) || [],
      lastEscalationAt,
      now,
      thresholdPercent: env.escalationThresholdPercent,
    });
    if (!decision.escalate) continue;

    const entry = {
      incident_id: incident.id,
      title: incident.title,
      from_priority: current.name,
      to_priority: next.name,
      reason: decision.reason,
    };

    if (dryRun) {
      escalated.push(entry);
      continue;
    }

    try {
      const applied = await db.withTransaction(async (query) => {
        // Re-read inside the transaction: if the incident was resolved or its
        // priority changed since we looked, leave it alone.
        const fresh = (
          await query("SELECT priority_id, status FROM incidents WHERE id = ?", [incident.id])
        ).rows[0];
        if (!fresh || fresh.priority_id !== incident.priority_id || !ESCALATABLE_STATUSES.includes(fresh.status)) {
          return false;
        }

        await query("UPDATE incidents SET priority_id = ? WHERE id = ?", [next.id, incident.id]);
        await query(
          `INSERT INTO incident_escalations
             (id, incident_id, from_priority_id, to_priority_id, reason, escalated_at, escalated_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          [crypto.randomUUID(), incident.id, current.id, next.id, decision.reason, now.toISOString()]
        );
        return true;
      });
      if (applied) escalated.push(entry);
    } catch (err) {
      errors.push({ incident_id: incident.id, error: err.message });
    }
  }

  return {
    ran_at: now.toISOString(),
    dry_run: dryRun,
    evaluated: candidates.length,
    escalated,
    errors,
  };
}

module.exports = { runEscalationCycle };
