// The lifecycle rules as the tests understand them, written out independently
// of the implementation. The domain tests prove the code matches this table;
// the integration and random-walk tests use it as their oracle. If a rule is
// meant to change, change it here on purpose and the failing tests show
// everything that depends on it.

const SPEC_STATUSES = ["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];

const SPEC_TRANSITIONS = {
  new: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["on_hold", "resolved", "cancelled"],
  on_hold: ["in_progress"],
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
  cancelled: [],
};

// Statuses where the incident is still being worked / waiting to be worked.
const SPEC_ACTIVE = ["new", "assigned", "in_progress", "on_hold"];
const SPEC_FINISHED = ["resolved", "closed"];

// "assigned" is in the transition table, but the status endpoint must refuse
// it: only the assignment endpoint can move an incident there (it records who).
function statusEndpointAllows(from, to) {
  return SPEC_TRANSITIONS[from].includes(to) && to !== "assigned";
}

function assignAllowed(status) {
  return status !== "closed" && status !== "cancelled";
}

module.exports = {
  SPEC_STATUSES,
  SPEC_TRANSITIONS,
  SPEC_ACTIVE,
  SPEC_FINISHED,
  statusEndpointAllows,
  assignAllowed,
};
