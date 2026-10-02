require("dotenv").config();
const crypto = require("crypto");
const db = require("../src/config/database");

// Default priority levels and their SLA targets, in minutes.
const PRIORITIES = [
  { name: "P1 - Critical", level: 1, sla_response_mins: 15, sla_resolution_mins: 240 },
  { name: "P2 - High", level: 2, sla_response_mins: 30, sla_resolution_mins: 480 },
  { name: "P3 - Medium", level: 3, sla_response_mins: 120, sla_resolution_mins: 1440 },
  { name: "P4 - Low", level: 4, sla_response_mins: 480, sla_resolution_mins: 4320 },
];

const CATEGORIES = ["Hardware", "Software", "Network", "Access/Account", "Other"];

async function upsertPriority(p) {
  const existing = await db.query("SELECT id FROM priorities WHERE name = ?", [p.name]);
  if (existing.rows.length) return;
  await db.query(
    "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), p.name, p.level, p.sla_response_mins, p.sla_resolution_mins]
  );
}

async function upsertCategory(name) {
  const existing = await db.query("SELECT id FROM categories WHERE name = ?", [name]);
  if (existing.rows.length) return;
  await db.query("INSERT INTO categories (id, name) VALUES (?, ?)", [crypto.randomUUID(), name]);
}

async function seed() {
  db.init();
  for (const p of PRIORITIES) await upsertPriority(p);
  for (const c of CATEGORIES) await upsertCategory(c);
  console.log("Seed complete: priorities and categories are in place.");
  await db.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exitCode = 1;
});
