// Pure audit rules (no database, no clock): which actions exist, which incident
// fields are worth recording, and how a before/after pair becomes a "changes"
// object. auditService persists what this module describes.

const ENTITY_TYPES = Object.freeze({ INCIDENT: "incident" });

const AUDIT_ACTIONS = Object.freeze({
  INCIDENT_CREATED: "incident.created",
  INCIDENT_ASSIGNED: "incident.assigned",
  INCIDENT_REASSIGNED: "incident.reassigned",
  INCIDENT_STATUS_CHANGED: "incident.status_changed",
  INCIDENT_REOPENED: "incident.reopened",
  INCIDENT_ESCALATED: "incident.escalated",
});

const AUDIT_ACTION_VALUES = Object.freeze(Object.values(AUDIT_ACTIONS));

// The incident columns recorded for each kind of action.
const FIELDS = Object.freeze({
  created: Object.freeze(["title", "status", "reporter_id", "team_id", "category_id", "priority_id", "due_at"]),
  assignment: Object.freeze(["status", "assignee_id"]),
  status: Object.freeze(["status", "resolved_at", "closed_at"]),
  escalation: Object.freeze(["priority_id"]),
});

function isValidAuditAction(action) {
  return AUDIT_ACTION_VALUES.includes(action);
}

/**
 * { field: { from, to } } for every listed field whose value differs between
 * `before` and `after`. A missing object or missing field counts as null, so
 * a creation (before = null) lists every non-null field as null -> value.
 */
function diffFields(before, after, fields) {
  const changes = {};
  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

/**
 * Merges the sources, dropping null, undefined and empty-string values so
 * audit rows don't carry noise. Returns null when nothing is left.
 */
function compactMetadata(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value !== null && value !== undefined && value !== "") result[key] = value;
    }
  }
  return Object.keys(result).length ? result : null;
}

module.exports = {
  ENTITY_TYPES,
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  FIELDS,
  isValidAuditAction,
  diffFields,
  compactMetadata,
};