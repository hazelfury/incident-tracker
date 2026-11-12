// Pure escalation rules (no database, no clock of its own).
//
// The rule: an open incident is raised ONE priority level once it has spent
// `thresholdPercent` of its current priority's resolution target at that
// priority without being resolved.
//
// Two details keep this from misbehaving:
//
//   - Time is measured from when the incident last changed priority (or from
//     creation if it never has), not from creation. Otherwise a three-day-old
//     P4 ticket would be above every threshold and climb P4 > P3 > P2 > P1 on
//     consecutive runs of the job, minutes apart.
//
//   - Time on hold is excluded, and an incident that is on hold right now is
//     never escalated: its SLA clock is paused, so its age isn't growing.

const { MINUTE_MS, toMs, holdPeriods, overlapMs } = require("./slaCalculator");

// Statuses an incident can be escalated from. on_hold is deliberately absent.
const lifecycle = require("./incidentLifecycle");
const ESCALATABLE_STATUSES = lifecycle.STATUSES.filter((s) => lifecycle.isActive(s) && s !== "on_hold");

/**
 * The next more-urgent priority: the one with the highest level number that is
 * still below the current level (level 1 is the most urgent). Returns null if
 * the incident is already at the top.
 */
function findNextHigherPriority(priorities, current) {
  let best = null;
  for (const p of priorities) {
    if (p.level < current.level && (best === null || p.level > best.level)) {
      best = p;
    }
  }
  return best;
}

// 45 -> "45m", 125 -> "2h 5m", 1620 -> "1d 3h"
function formatMinutes(totalMinutes) {
  const mins = Math.max(0, Math.round(totalMinutes));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Decides whether one incident should escalate right now.
 *
 *   incident          { status, created_at }
 *   currentPriority   { name, level, sla_resolution_mins }
 *   nextPriority      the next higher priority, or null if already highest
 *   history           status-history rows (only on-hold ones matter)
 *   lastEscalationAt  when it last changed priority, or null
 *   now               Date
 *
 * Returns { escalate, skip?, reason?, active_ms, threshold_ms }.
 * When escalate is false, `skip` says why: not_active | on_hold |
 * highest_priority | invalid_dates | below_threshold.
 */
function decideEscalation({
  incident,
  currentPriority,
  nextPriority,
  history = [],
  lastEscalationAt = null,
  now = new Date(),
  thresholdPercent = 75,
}) {
  if (incident.status === "on_hold") return { escalate: false, skip: "on_hold" };
  if (!ESCALATABLE_STATUSES.includes(incident.status)) return { escalate: false, skip: "not_active" };
  if (!nextPriority) return { escalate: false, skip: "highest_priority" };

  const nowMs = toMs(now);
  const createdMs = toMs(incident.created_at);
  if (createdMs === null || nowMs === null) return { escalate: false, skip: "invalid_dates" };

  const lastMs = toMs(lastEscalationAt);
  const startMs = lastMs === null ? createdMs : Math.max(createdMs, lastMs);

  const holds = holdPeriods(history, nowMs, incident.status);
  const activeMs = Math.max(0, nowMs - startMs - overlapMs(holds, startMs, nowMs));
  const targetMins = currentPriority.sla_resolution_mins;
  const thresholdMs = (thresholdPercent / 100) * targetMins * MINUTE_MS;

  if (activeMs < thresholdMs) {
    return { escalate: false, skip: "below_threshold", active_ms: activeMs, threshold_ms: thresholdMs };
  }

  return {
    escalate: true,
    active_ms: activeMs,
    threshold_ms: thresholdMs,
    reason:
      `Open ${formatMinutes(activeMs / MINUTE_MS)} at ${currentPriority.name} without resolution ` +
      `(escalates after ${thresholdPercent}% of its ${formatMinutes(targetMins)} target). ` +
      `Raised to ${nextPriority.name}.`,
  };
}

module.exports = {
  ESCALATABLE_STATUSES,
  findNextHigherPriority,
  formatMinutes,
  decideEscalation,
};
