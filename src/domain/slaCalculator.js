// Pure SLA logic: no database, no clock of its own (callers pass `now`), so
// every rule below can be tested with exact times.
//
// Two SLAs are tracked per incident:
//
//   Resolution: the incident must be resolved by incidents.due_at, which the
//     app sets at creation from the priority's sla_resolution_mins. Time spent
//     "on hold" does not count against it (the clock pauses, as designed in
//     the Week 1 lifecycle).
//
//   Response: the incident must be picked up (first assignment) within the
//     priority's sla_response_mins of creation. Not paused by anything.
//
// The resolution target comes from the stored due_at, not from the incident's
// *current* priority. That matters for escalation: raising an incident from
// P3 to P2 must not retroactively make it "breached" against P2's shorter
// target, since the escalation itself is meant to prevent a breach.

const MINUTE_MS = 60000;
const DEFAULT_AT_RISK_PERCENT = 80;

const { FINISHED_STATUSES } = require("./incidentLifecycle");

// Accepts a Date, epoch ms, an ISO string, or SQLite's zone-less
// "YYYY-MM-DD HH:MM:SS" (UTC) default. Returns epoch ms, or null if unusable.
function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

const iso = (ms) => new Date(ms).toISOString();
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Time spans during which the incident was on hold, as [startMs, endMs] pairs.
 *
 * A hold starts at a status-history row whose to_status is "on_hold" and ends
 * at the next row (any transition out). The last hold is only treated as still
 * open if the incident is on hold *right now*; otherwise it gets zero length.
 * That guard means a mis-ordered pair of same-millisecond history rows can at
 * worst lose a pause, never freeze an SLA clock forever.
 */
function holdPeriods(history, nowMs, currentStatus) {
  const rows = history
    .map((h) => ({ to_status: h.to_status, t: toMs(h.changed_at) }))
    .filter((h) => h.t !== null)
    .sort((a, b) => a.t - b.t);

  const periods = [];
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].to_status !== "on_hold") continue;
    const start = rows[k].t;
    if (k + 1 < rows.length) {
      periods.push([start, rows[k + 1].t]);
    } else {
      periods.push([start, currentStatus === "on_hold" ? nowMs : start]);
    }
  }
  return periods;
}

// Total length of `periods` that falls inside [fromMs, toMs].
function overlapMs(periods, fromMs, toMsEnd) {
  let total = 0;
  for (const [start, end] of periods) {
    const overlap = Math.min(end, toMsEnd) - Math.max(start, fromMs);
    if (overlap > 0) total += overlap;
  }
  return total;
}

function evaluateResolution({ incident, history, now, atRiskPercent }) {
  const createdMs = toMs(incident.created_at);
  const dueMs = toMs(incident.due_at);
  const status = incident.status;

  if (status === "cancelled" || createdMs === null || dueMs === null) {
    return {
      status: "not_applicable",
      breached: false,
      paused: false,
      due_at: dueMs === null ? null : iso(dueMs),
      original_due_at: dueMs === null ? null : iso(dueMs),
      remaining_ms: null,
      percent_elapsed: null,
      paused_ms: 0,
    };
  }

  const finished = FINISHED_STATUSES.includes(status);
  const endMs = finished ? (toMs(incident.resolved_at) ?? now) : now;

  const pausedMs = overlapMs(holdPeriods(history, now, status), createdMs, endMs);
  const windowMs = dueMs - createdMs;
  const elapsedMs = Math.max(0, endMs - createdMs - pausedMs);
  const remainingMs = windowMs - elapsedMs;
  const percent = windowMs > 0 ? (elapsedMs / windowMs) * 100 : 100;
  const paused = status === "on_hold";

  let state;
  if (elapsedMs > windowMs)
    state = "breached"; // for finished incidents this means "resolved late"
  else if (finished) state = "met";
  else if (paused) state = "paused";
  else if (percent >= atRiskPercent) state = "at_risk";
  else state = "on_track";

  return {
    status: state,
    breached: state === "breached",
    paused,
    due_at: iso(dueMs + pausedMs), // the original target pushed out by time on hold
    original_due_at: iso(dueMs),
    remaining_ms: Math.round(remainingMs), // negative once breached
    percent_elapsed: round1(percent),
    paused_ms: Math.round(pausedMs),
  };
}

function evaluateResponse({ incident, responseTargetMins, firstResponseAt, now }) {
  const createdMs = toMs(incident.created_at);
  if (
    incident.status === "cancelled" ||
    responseTargetMins === null ||
    responseTargetMins === undefined ||
    createdMs === null
  ) {
    return { status: "not_applicable", breached: false, due_at: null, responded_at: null };
  }

  const dueMs = createdMs + responseTargetMins * MINUTE_MS;
  const respondedMs = toMs(firstResponseAt);

  let state;
  if (respondedMs !== null) state = respondedMs <= dueMs ? "met" : "breached";
  else state = now > dueMs ? "breached" : "pending";

  return {
    status: state,
    breached: state === "breached",
    due_at: iso(dueMs),
    responded_at: respondedMs === null ? null : iso(respondedMs),
  };
}

/**
 * Full SLA picture for one incident.
 *
 *   incident          { status, created_at, due_at, resolved_at }
 *   responseTargetMins response target (minutes) of the priority the incident
 *                     had when it was created
 *   history           status-history rows ({ to_status, changed_at }); only
 *                     the on-hold ones affect the result
 *   firstResponseAt   when the incident was first assigned, or null
 *   now               Date or epoch ms
 *
 * Resolution status: on_track | at_risk | breached | paused | met | not_applicable
 *   (a finished incident is "met" if resolved in time, "breached" if late)
 * Response status:   pending | met | breached | not_applicable
 */
function evaluateSla({
  incident,
  responseTargetMins = null,
  history = [],
  firstResponseAt = null,
  now,
  atRiskPercent = DEFAULT_AT_RISK_PERCENT,
}) {
  const nowMs = toMs(now);
  if (nowMs === null) {
    throw new TypeError("evaluateSla: `now` is required (Date, epoch ms or ISO string)");
  }
  const resolution = evaluateResolution({ incident, history, now: nowMs, atRiskPercent });
  const response = evaluateResponse({ incident, responseTargetMins, firstResponseAt, now: nowMs });

  return {
    evaluated_at: iso(nowMs),
    breached: resolution.breached || response.breached,
    resolution,
    response,
  };
}

module.exports = {
  MINUTE_MS,
  DEFAULT_AT_RISK_PERCENT,
  toMs,
  holdPeriods,
  overlapMs,
  evaluateSla,
};
