require("dotenv").config();

// Parses a numeric env var, falling back to the default if it's missing,
// not a number, or not above `min` (so a typo can't turn escalation into
// "escalate on every run").
function num(value, fallback, min = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > min ? n : fallback;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "4000", 10),

  // "sqlite" | "postgres"
  dbClient: process.env.DB_CLIENT || "sqlite",

  sqliteFile: process.env.SQLITE_FILE || "./data/dev.sqlite3",

  databaseUrl: process.env.DATABASE_URL,
  pgPoolMax: parseInt(process.env.PG_POOL_MAX || "10", 10),
  pgIdleTimeoutMs: parseInt(process.env.PG_IDLE_TIMEOUT_MS || "30000", 10),
  pgConnTimeoutMs: parseInt(process.env.PG_CONN_TIMEOUT_MS || "5000", 10),

  corsOrigin: process.env.CORS_ORIGIN || "*",

  // SLA and escalation policy (see README, "Week 6").
  // An open incident is "at risk" once this % of its resolution target is used.
  slaAtRiskPercent: num(process.env.SLA_AT_RISK_PERCENT, 80),
  // An open incident escalates one priority level once it has spent this % of
  // its current priority's resolution target at that priority without resolution.
  escalationThresholdPercent: num(process.env.ESCALATION_THRESHOLD_PERCENT, 75),
  escalationEnabled: String(process.env.ESCALATION_ENABLED || "true").toLowerCase() !== "false",
  escalationIntervalSeconds: num(process.env.ESCALATION_INTERVAL_SECONDS, 60),
};
