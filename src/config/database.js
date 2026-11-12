const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const env = require("./env");

let pgPool = null;
let sqliteDb = null;

const usePostgres = () => env.dbClient === "postgres";

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
  return usePostgres() ? initPostgres() : initSqlite();
}

// node-postgres needs $1, $2, ... placeholders; better-sqlite3 needs ?.
// Callers always write "?" and this converts it for Postgres, so query()
// and the SQL in database/schema.sql stay identical across both dialects.
function toPgPlaceholders(text) {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

// Runs one statement on a better-sqlite3 connection and returns { rows }.
// stmt.reader is true for anything that returns rows (SELECT, WITH ... SELECT,
// INSERT ... RETURNING), so those behave the same as they do on Postgres.
function runSqlite(db, text, params = []) {
  const stmt = db.prepare(text);
  if (stmt.reader) {
    return { rows: stmt.all(...params) };
  }
  stmt.run(...params);
  return { rows: [] };
}

// Runs one statement on a pg Pool or checked-out client and returns { rows }.
async function runPg(target, text, params = []) {
  const result = await target.query(toPgPlaceholders(text), params);
  return { rows: result.rows };
}

/**
 * Unified query interface so route/service code doesn't need to branch on
 * which database is behind it. Always resolves to { rows }.
 *
 * SQLite's driver is synchronous under the hood; this just wraps it in a
 * promise so callers can `await` regardless of dbClient.
 */
async function query(text, params = []) {
  return usePostgres() ? runPg(initPostgres(), text, params) : runSqlite(initSqlite(), text, params);
}

/**
 * For multi-statement work / transactions. Postgres hands back a checked-out
 * pool client that MUST be released; SQLite hands back its single connection
 * with a no-op release() so calling code doesn't need an if/else.
 */
async function getClient() {
  if (usePostgres()) {
    const pool = initPostgres();
    const client = await pool.connect();
    return { client, release: () => client.release() };
  }
  const db = initSqlite();
  return { client: db, release: () => {} };
}

async function runTransaction(fn) {
  const isPg = usePostgres();
  const { client, release } = await getClient();

  const txQuery = async (text, params = []) => (isPg ? runPg(client, text, params) : runSqlite(client, text, params));

  const exec = (sql) => (isPg ? client.query(sql) : client.exec(sql));

  try {
    await exec("BEGIN");
    const result = await fn(txQuery);
    await exec("COMMIT");
    return result;
  } catch (err) {
    try {
      await exec("ROLLBACK");
    } catch (_) {
      // Ignore rollback failures; the original error is what matters.
    }
    throw err;
  } finally {
    release();
  }
}

// SQLite has one shared connection, so two overlapping transactions would
// both issue BEGIN on it. Queue them so they run one at a time. (Postgres
// gives each transaction its own pooled client and needs no queue.)
// Note: a transaction callback must not start another withTransaction() call,
// or it would wait on itself.
let sqliteTransactionQueue = Promise.resolve();

function runExclusive(task) {
  const result = sqliteTransactionQueue.then(task);
  sqliteTransactionQueue = result.catch(() => {});
  return result;
}

/**
 * Runs `fn` inside a BEGIN/COMMIT (or ROLLBACK on error) block and hands it
 * a `query(text, params)` function bound to that single connection, using
 * the same "?" placeholder convention as the module-level query() above.
 * Use this whenever an operation needs more than one write to stay atomic
 * (e.g. reassigning an incident touches incidents, incident_assignments,
 * and incident_status_history together).
 */
function withTransaction(fn) {
  return usePostgres() ? runTransaction(fn) : runExclusive(() => runTransaction(fn));
}

/**
 * Runs a raw, multi-statement SQL script (schema migrations, seed files).
 * Not parameterized and not for request-path use; query() above is for that.
 */
async function runScript(sql) {
  if (usePostgres()) {
    const pool = initPostgres();
    await pool.query(sql);
    return;
  }
  const db = initSqlite();
  db.exec(sql);
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

module.exports = {
  init,
  query,
  getClient,
  withTransaction,
  runScript,
  healthCheck,
  close,
};
