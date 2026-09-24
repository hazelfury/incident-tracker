const createApp = require("./app");
const env = require("./config/env");
const db = require("./config/database");

const app = createApp();

// Establish the pool / connection at startup rather than lazily on first
// request, so a bad DB config fails fast instead of on the first user request.
db.init();

const server = app.listen(env.port, () => {
  console.log(
    `Incident tracker backend listening on port ${env.port} (env=${env.nodeEnv}, db=${env.dbClient})`
  );
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  // Force-exit if something hangs during shutdown.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = server;
