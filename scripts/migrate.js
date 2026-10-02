require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../src/config/database");
const env = require("../src/config/env");

async function migrate() {
  const schemaPath = path.join(__dirname, "..", "database", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  db.init();
  console.log(`Applying schema.sql to ${env.dbClient}...`);
  await db.runScript(sql);
  console.log("Schema applied.");
  await db.close();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
