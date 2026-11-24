// Pure rules for assigning incidents (no database, no clock): who may be
// assigned or may assign, and what a valid assignment request looks like.
// incidentService applies these inside the assignment workflow.

// Only staff work incidents. A requester reports them.
const STAFF_ROLES = Object.freeze(["agent", "manager", "admin"]);

const MAX_REASON_LENGTH = 500;

function canBeAssignee(role) {
  return STAFF_ROLES.includes(role);
}

function canAssignIncidents(role) {
  return STAFF_ROLES.includes(role);
}

function assigneeRoleMessage(userId, role) {
  return `assignedTo must be an agent, manager or admin, but user ${userId} is a ${role}`;
}

function assignerRoleMessage(userId, role) {
  return `assignedBy must be an agent, manager or admin, but user ${userId} is a ${role}`;
}

const isBlank = (value) => value === undefined || value === null || value === "";

/**
 * Checks the shape of an assignment request. Returns an error message, or
 * null if it is acceptable. Without this, a wrongly typed field (an object
 * where an id is expected) would reach the database driver and come back as a
 * 500 instead of a 400.
 */
function validateAssignmentInput({ assignedTo, assignedBy, reason }) {
  if (isBlank(assignedTo)) return "assignedTo is required";
  if (typeof assignedTo !== "string") return "assignedTo must be a user id (string)";
  if (!isBlank(assignedBy) && typeof assignedBy !== "string") return "assignedBy must be a user id (string)";
  if (!isBlank(reason)) {
    if (typeof reason !== "string") return "reason must be text";
    if (reason.trim().length > MAX_REASON_LENGTH) return `reason must be ${MAX_REASON_LENGTH} characters or fewer`;
  }
  return null;
}

// Trimmed text, or null when there is nothing meaningful to store.
function normalizeReason(reason) {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}

module.exports = {
  STAFF_ROLES,
  MAX_REASON_LENGTH,
  canBeAssignee,
  canAssignIncidents,
  assigneeRoleMessage,
  assignerRoleMessage,
  validateAssignmentInput,
  normalizeReason,
};