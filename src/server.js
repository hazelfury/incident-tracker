const createApp = require("./app");
const env = require("./config/env");
const db = require("./config/database");
const { startEscalationJob } = require("./jobs/escalationJob");

const app = createApp();

db.init();

const server = app.listen(env.port, () => {
  console.log(
    `Incident tracker backend listening on port ${env.port} (env=${env.nodeEnv}, db=${env.dbClient})`
  );
});

// Automatic priority escalation runs on a timer inside the server process.
// (Tests import app.js only, so they never start it.)
const escalationJob = env.escalationEnabled
  ? startEscalationJob({ intervalMs: env.escalationIntervalSeconds * 1000 })
  : null;
console.log(
  escalationJob
    ? `Escalation job running every ${env.escalationIntervalSeconds}s (threshold ${env.escalationThresholdPercent}%)`
    : "Escalation job disabled (ESCALATION_ENABLED=false)"
);

async function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  if (escalationJob) await escalationJob.stop();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = server;
