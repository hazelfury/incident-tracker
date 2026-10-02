const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const env = require("./env");

let pgPool = null;
let sqliteDb = null;

function initPostgres() {
  if (pgPool) return pgPool;
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required when DB_CLIENT=postgres");
  }

  pgPool = new Pool({
    connectionString: env.databaseUrl,
    max: env.pgPoolMax,
    idleTimeoutMillis: env.pgIdleTimeoutMs,
    connectionTimeoutMillis: env.pgConnTimeoutMs,
  });

  // Without this handler, an error on an idle client (e.g. the DB restarting)
  // becomes an uncaught exception and crashes the process.
  pgPool.on("error", (err) => {
    console.error("Unexpected PostgreSQL pool error", err);
  });

  return pgPool;
}

function initSqlite() {
  if (sqliteDb) return sqliteDb;
  const Database = require("better-sqlite3");

  if (env.sqliteFile !== ":memory:") {
    const dir = path.dirname(env.sqliteFile);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  sqliteDb = new Database(env.sqliteFile);
  sqliteDb.pragma("journal_mode = WAL");
  // SQLite ignores REFERENCES constraints unless this is turned on explicitly.
  sqliteDb.pragma("foreign_keys = ON");
  return sqliteDb;
}

function init() {
  return env.dbClient === "postgres" ? initPostgres() : initSqlite();
}

// node-postgres needs $1, $2, ... placeholders; better-sqlite3 needs ?.
// Callers always write "?" and this converts it for Postgres, so query()
// and the SQL in database/schema.sql stay identical across both dialects.
function toPgPlaceholders(text) {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

/**
 * Unified query interface so route/service code doesn't need to branch on
 * which database is behind it. Always resolves to { rows }.
 *
 * SQLite's driver is synchronous under the hood; this just wraps it in a
 * promise so callers can `await` regardless of dbClient.
 */
async function query(text, params = []) {
  if (env.dbClient === "postgres") {
    const pool = initPostgres();
    const result = await pool.query(toPgPlaceholders(text), params);
    return { rows: result.rows };
  }

  const db = initSqlite();
  const stmt = db.prepare(text);
  const isSelect = /^\s*select/i.test(text);
  const rows = isSelect ? stmt.all(...params) : (stmt.run(...params), []);
  return { rows };
}

/**
 * Runs a raw, multi-statement SQL script (schema migrations, seed files).
 * Not parameterized and not for request-path use — query() above is for that.
 */
async function runScript(sql) {
  if (env.dbClient === "postgres") {
    const pool = initPostgres();
    await pool.query(sql);
    return;
  }
  const db = initSqlite();
  db.exec(sql);
}

/**
 * For multi-statement work / transactions. Postgres hands back a checked-out
 * pool client that MUST be released; SQLite hands back its single connection
 * with a no-op release() so calling code doesn't need an if/else.
 */
async function getClient() {
  if (env.dbClient === "postgres") {
    const pool = initPostgres();
    const client = await pool.connect();
    return { client, release: () => client.release() };
  }
  const db = initSqlite();
  return { client: db, release: () => {} };
}

async function healthCheck() {
  await query("SELECT 1");
  return true;
}

async function close() {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}

module.exports = { init, query, getClient, runScript, healthCheck, close };
