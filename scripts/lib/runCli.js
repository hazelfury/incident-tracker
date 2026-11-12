const db = require("../../src/config/database");

/**
 * Runs a command-line task with the lifecycle every script needs: initialise
 * the database, run `task`, report failure through the exit code, and always
 * close the database. Closing in `finally` matters on Postgres, where an open
 * connection pool would otherwise keep the process alive after a failure.
 *
 * Importing the database module also loads .env (via config/env.js), so
 * scripts don't need to call dotenv themselves.
 */
async function runCli(task, { label = "Script" } = {}) {
  try {
    db.init();
    await task();
  } catch (err) {
    console.error(`${label} failed:`, err);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

module.exports = { runCli };