require("dotenv").config();

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
};
