const db = require("../config/database");

// Priority levels with their SLA targets. The dashboard uses these for the
// priority filter, the colour legend, and the SLA hints.
async function listPriorities() {
  const { rows } = await db.query(
    "SELECT id, name, level, sla_response_mins, sla_resolution_mins FROM priorities ORDER BY level ASC"
  );
  return rows;
}

module.exports = { listPriorities };
