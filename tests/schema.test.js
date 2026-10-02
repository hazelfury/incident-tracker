const fs = require("fs");
const path = require("path");
const db = require("../src/config/database");

const schemaSql = fs.readFileSync(
  path.join(__dirname, "..", "database", "schema.sql"),
  "utf8"
);

beforeAll(async () => {
  db.init();
  await db.runScript(schemaSql);
});

afterAll(async () => {
  await db.close();
});

describe("schema migration", () => {
  it("creates all expected tables", async () => {
    const { rows } = await db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    const names = rows.map((r) => r.name);
    [
      "teams",
      "users",
      "categories",
      "priorities",
      "incidents",
      "incident_assignments",
      "incident_status_history",
    ].forEach((table) => expect(names).toContain(table));
  });
});

describe("priorities (SLA)", () => {
  it("stores response and resolution SLA targets", async () => {
    await db.query(
      "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
      ["pri-critical", "P1 - Critical", 1, 15, 240]
    );

    const { rows } = await db.query(
      "SELECT * FROM priorities WHERE id = ?",
      ["pri-critical"]
    );
    expect(rows[0].sla_response_mins).toBe(15);
    expect(rows[0].sla_resolution_mins).toBe(240);
  });
});

describe("incidents", () => {
  beforeAll(async () => {
    await db.query("INSERT INTO teams (id, name) VALUES (?, ?)", ["team-1", "Support"]);
    await db.query(
      "INSERT INTO users (id, name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["user-1", "Test Agent", "agent@example.com", "hash", "agent", "team-1"]
    );
    await db.query("INSERT INTO categories (id, name) VALUES (?, ?)", ["cat-1", "Software"]);
  });

  it("rejects a status outside the allowed lifecycle values", async () => {
    await expect(
      db.query(
        "INSERT INTO incidents (id, title, status, reporter_id, category_id, priority_id) VALUES (?, ?, ?, ?, ?, ?)",
        ["inc-bad", "Test incident", "not_a_real_status", "user-1", "cat-1", "pri-critical"]
      )
    ).rejects.toThrow();
  });

  it("accepts a valid status and defaults to 'new' when omitted", async () => {
    await db.query(
      "INSERT INTO incidents (id, title, reporter_id, category_id, priority_id) VALUES (?, ?, ?, ?, ?)",
      ["inc-good", "Test incident", "user-1", "cat-1", "pri-critical"]
    );
    const { rows } = await db.query("SELECT status FROM incidents WHERE id = ?", ["inc-good"]);
    expect(rows[0].status).toBe("new");
  });
});

describe("incident_assignments and incident_status_history", () => {
  it("records an assignment and a status change as separate history rows", async () => {
    await db.query(
      "INSERT INTO incident_assignments (id, incident_id, assigned_to, assigned_by) VALUES (?, ?, ?, ?)",
      ["assign-1", "inc-good", "user-1", "user-1"]
    );
    await db.query(
      "INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by) VALUES (?, ?, ?, ?, ?)",
      ["hist-1", "inc-good", "new", "assigned", "user-1"]
    );

    const assignments = await db.query(
      "SELECT * FROM incident_assignments WHERE incident_id = ?",
      ["inc-good"]
    );
    const history = await db.query(
      "SELECT * FROM incident_status_history WHERE incident_id = ?",
      ["inc-good"]
    );

    expect(assignments.rows).toHaveLength(1);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].to_status).toBe("assigned");
  });
});
