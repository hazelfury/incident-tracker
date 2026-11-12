const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const request = require("supertest");
const createApp = require("../src/app");
const db = require("../src/config/database");

const schemaSql = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");

const app = createApp();

let reporter, agent, category, critical, low;
let newIncidentId, assignedIncidentId;

async function createIncident(title, priorityId) {
  const res = await request(app).post("/api/incidents").send({
    title,
    reporterId: reporter,
    categoryId: category,
    priorityId,
  });
  return res.body.id;
}

beforeAll(async () => {
  db.init();
  await db.runScript(schemaSql);

  reporter = crypto.randomUUID();
  agent = crypto.randomUUID();
  category = crypto.randomUUID();
  critical = crypto.randomUUID();
  low = crypto.randomUUID();

  await db.query("INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)", [
    reporter,
    "Riley Requester",
    "riley@example.com",
    "hash",
    "requester",
  ]);
  await db.query("INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)", [
    agent,
    "Amara Agent",
    "amara@example.com",
    "hash",
    "agent",
  ]);
  await db.query("INSERT INTO categories (id, name) VALUES (?, ?)", [category, "Network"]);
  // Inserted out of order on purpose, to prove the API sorts by level.
  await db.query(
    "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
    [low, "P4 - Low", 4, 480, 4320]
  );
  await db.query(
    "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
    [critical, "P1 - Critical", 1, 15, 240]
  );

  newIncidentId = await createIncident("Stays new", low);
  assignedIncidentId = await createIncident("Gets assigned", critical);
  await request(app)
    .patch(`/api/incidents/${assignedIncidentId}/assignment`)
    .send({ assignedTo: agent, assignedBy: agent, reason: "taking it" });
  await request(app)
    .patch(`/api/incidents/${assignedIncidentId}/status`)
    .send({ status: "in_progress", changedBy: agent, note: "On it" });
});

afterAll(async () => {
  await db.close();
});

describe("GET /api/priorities", () => {
  it("returns priorities ordered by level with their SLA targets", async () => {
    const res = await request(app).get("/api/priorities");
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.level)).toEqual([1, 4]);
    expect(res.body[0]).toMatchObject({
      name: "P1 - Critical",
      sla_response_mins: 15,
      sla_resolution_mins: 240,
    });
  });
});

describe("GET /api/incidents (dashboard list)", () => {
  it("includes the names the dashboard needs", async () => {
    const res = await request(app).get("/api/incidents");
    expect(res.status).toBe(200);

    const row = res.body.find((i) => i.id === assignedIncidentId);
    expect(row).toMatchObject({
      priority_name: "P1 - Critical",
      priority_level: 1,
      category_name: "Network",
      assignee_name: "Amara Agent",
      reporter_name: "Riley Requester",
      status: "in_progress",
    });
  });

  it("returns unassigned incidents with a null assignee_name", async () => {
    const res = await request(app).get("/api/incidents");
    const row = res.body.find((i) => i.id === newIncidentId);
    expect(row.assignee_id).toBeNull();
    expect(row.assignee_name).toBeNull();
  });

  it("lists the most urgent priority first", async () => {
    const res = await request(app).get("/api/incidents");
    expect(res.body.map((i) => i.priority_level)).toEqual([1, 4]);
  });
});

describe("GET /api/incidents?status=", () => {
  it("filters to a single status", async () => {
    const res = await request(app).get("/api/incidents?status=new");
    expect(res.status).toBe(200);
    expect(res.body.map((i) => i.id)).toEqual([newIncidentId]);
  });

  it("accepts a comma-separated list of statuses", async () => {
    const res = await request(app).get("/api/incidents?status=new,in_progress");
    expect(res.body).toHaveLength(2);
  });

  it("returns an empty list for a valid status with no incidents", async () => {
    const res = await request(app).get("/api/incidents?status=closed");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 400 for an unknown status, naming the valid ones", async () => {
    const res = await request(app).get("/api/incidents?status=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Invalid status filter: bogus/);
    expect(res.body.error.message).toMatch(/in_progress/);
  });
});

describe("GET /api/incidents/:id (detail)", () => {
  it("adds readable names to the assignment and status history", async () => {
    const res = await request(app).get(`/api/incidents/${assignedIncidentId}`);
    expect(res.status).toBe(200);
    expect(res.body.priority_name).toBe("P1 - Critical");

    expect(res.body.assignments[0]).toMatchObject({
      assigned_to_name: "Amara Agent",
      assigned_by_name: "Amara Agent",
      reason: "taking it",
    });
    const last = res.body.statusHistory[res.body.statusHistory.length - 1];
    expect(last).toMatchObject({ to_status: "in_progress", changed_by_name: "Amara Agent", note: "On it" });
  });
});

describe("dashboard static files", () => {
  it("serves the dashboard page at /", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("Incident Dashboard");
  });

  it("serves the stylesheet and scripts the page references", async () => {
    for (const file of ["/css/styles.css", "/js/dashboard-utils.js", "/js/app.js"]) {
      const res = await request(app).get(file);
      expect(res.status).toBe(200);
    }
  });

  it("does not let the CSP upgrade http requests to https (breaks plain-http localhost in some browsers)", async () => {
    const res = await request(app).get("/");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/upgrade-insecure-requests/);
    expect(csp).toMatch(/script-src 'self'/);
  });

  it("still returns the JSON 404 for unknown API routes", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Route not found/);
  });
});
