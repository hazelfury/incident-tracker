require("dotenv").config();
const db = require("../src/config/database");
const env = require("../src/config/env");
const { runEscalationCycle } = require("../src/services/escalationService");

// npm run sla:escalate                 run one escalation cycle now
// npm run sla:escalate -- --dry-run    show what would escalate, change nothing
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  db.init();

  const result = await runEscalationCycle({ dryRun });

  console.log(
    `${dryRun ? "[dry run] " : ""}Checked ${result.evaluated} open incident(s) ` +
      `(escalation threshold ${env.escalationThresholdPercent}%).`
  );
  if (!result.escalated.length) {
    console.log("Nothing to escalate.");
  } else {
    console.log(`${dryRun ? "Would escalate" : "Escalated"} ${result.escalated.length}:`);
    result.escalated.forEach((e) => {
      console.log(`  - ${e.title}: ${e.from_priority} -> ${e.to_priority}`);
      console.log(`      ${e.reason}`);
    });
  }
  if (result.errors.length) {
    console.error("Errors:", result.errors);
    process.exitCode = 1;
  }

  await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
