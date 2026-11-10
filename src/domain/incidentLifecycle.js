// The incident lifecycle rules, as pure functions and data (no database, no
// clock). incidentService applies these inside transactions; keeping them here
// means every rule can be unit-tested directly.
//
//   new -> assigned -> in_progress -> resolved -> closed
//                         |  ^            |         |
//                         v  |            +---------+--> back to in_progress (reopen)
//                       on_hold
//   cancelled: reachable from new, assigned and in_progress; nothing leaves it.

const STATUSES = Object.freeze([
  "new",
  "assigned",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "cancelled",
]);

// Which statuses an incident may move to from each status.
const TRANSITIONS = Object.freeze({
  new: Object.freeze(["assigned", "cancelled"]),
  assigned: Object.freeze(["in_progress", "cancelled"]),
  in_progress: Object.freeze(["on_hold", "resolved", "cancelled"]),
  on_hold: Object.freeze(["in_progress"]),
  resolved: Object.freeze(["closed", "in_progress"]), // reopen straight from resolved
  closed: Object.freeze(["in_progress"]), // reopen after closing
  cancelled: Object.freeze([]), // terminal
});

// Work is done (or abandoned): SLA timers and escalation no longer apply.
const FINISHED_STATUSES = Object.freeze(["resolved", "closed"]);
const INACTIVE_STATUSES = Object.freeze(["resolved", "closed", "cancelled"]);

// An incident in any of these must have an assignee: it can only get here by
// being assigned first.
const ASSIGNEE_REQUIRED_STATUSES = Object.freeze([
  "assigned",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
]);

function isValidStatus(status) {
  return STATUSES.includes(status);
}

// Copy, so a caller can't mutate the table by accident. Unknown status -> [].
// (hasOwnProperty, so inherited names like "constructor" aren't mistaken for statuses.)
function allowedNext(from) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, from) ? [...TRANSITIONS[from]] : [];
}

function canTransition(from, to) {
  return allowedNext(from).includes(to);
}

function isActive(status) {
  return isValidStatus(status) && !INACTIVE_STATUSES.includes(status);
}

function isFinished(status) {
  return FINISHED_STATUSES.includes(status);
}

// closed and cancelled incidents are off the table; everything else, including
// a resolved one, can still be (re)assigned.
function canAssign(status) {
  return status !== "cancelled" && status !== "closed";
}

// Assigning a brand-new incident moves it to "assigned"; any other status is kept.
function statusAfterAssignment(status) {
  return status === "new" ? "assigned" : status;
}

// Moving back to in_progress from a finished status is a "reopen".
function isReopen(from, to) {
  return to === "in_progress" && FINISHED_STATUSES.includes(from);
}

/**
 * The resolved_at / closed_at values after a transition.
 *   resolved -> resolved_at = now
 *   closed   -> closed_at   = now (resolved_at is kept)
 *   reopen   -> both cleared
 *   anything else leaves both as they were
 */
function timestampsForTransition({ from, to, now, resolved_at = null, closed_at = null }) {
  const reopening = isReopen(from, to);
  return {
    resolved_at: to === "resolved" ? now : reopening ? null : resolved_at ?? null,
    closed_at: to === "closed" ? now : reopening ? null : closed_at ?? null,
  };
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  FINISHED_STATUSES,
  INACTIVE_STATUSES,
  ASSIGNEE_REQUIRED_STATUSES,
  isValidStatus,
  allowedNext,
  canTransition,
  isActive,
  isFinished,
  canAssign,
  statusAfterAssignment,
  isReopen,
  timestampsForTransition,
};
