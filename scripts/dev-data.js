require("dotenv").config();
const crypto = require("crypto");
const db = require("../src/config/database");

async function getOrCreateUser(name, email, role) {
  const existing = await db.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.rows.length) return existing.rows[0].id;
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
    [id, name, email, "dev-only-hash", role]
  );
  return id;
}

async function main() {
  db.init();

  const priority = (await db.query("SELECT id FROM priorities WHERE level = 2")).rows[0];
  const category = (await db.query("SELECT id FROM categories LIMIT 1")).rows[0];
  if (!priority || !category) {
    throw new Error("No priorities/categories found. Run npm run db:seed first.");
  }

  const reporter = await getOrCreateUser("Riley Requester", "riley@example.com", "requester");
  const agent = await getOrCreateUser("Amara Agent", "amara@example.com", "agent");
  const agent2 = await getOrCreateUser("Omar Agent", "omar@example.com", "agent");

  console.log("Paste these into PowerShell:\n");
  console.log(`$reporter = "${reporter}"`);
  console.log(`$agent = "${agent}"`);
  console.log(`$agent2 = "${agent2}"`);
  console.log(`$priority = "${priority.id}"`);
  console.log(`$category = "${category.id}"`);

  await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});