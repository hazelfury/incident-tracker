const fs = require("fs");
const path = require("path");
const request = require("supertest");
const crypto = require("crypto");
const createApp = require("../src/app");
const db = require("../src/config/database");

const schemaSql = fs.readFileSync(
  path.join(__dirname, "..", "database", "schema.sql"),
  "utf8"
);

const app = createApp();

let reporter, agent, otherAgent, category, priority, team;

beforeAll(async () => {
  db.init();
  await db.runScript(schemaSql);

  team = crypto.randomUUID();
  reporter = crypto.randomUUID();
  agent = crypto.randomUUID();
  otherAgent = crypto.randomUUID();
  category = crypto.randomUUID();
  priority = crypto.randomUUID();

  await db.query("INSERT INTO teams (id, name) VALUES (?, ?)", [team, "Support"]);
  await db.query(
    "INSERT INTO users (id, name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)",
    [reporter, "Riley Requester", "riley@example.com", "hash", "requester", team]
  );
  await db.query(
    "INSERT INTO users (id, name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)",
    [agent, "Amara Agent", "amara@example.com", "hash", "agent", team]
  );
  await db.query(
    "INSERT INTO users (id, name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)",
    [otherAgent, "Omar Agent", "omar@example.com", "hash", "agent", team]
  );
  await db.query("INSERT INTO categories (id, name) VALUES (?, ?)", [category, "Software"]);
  await db.query(
    "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
    [priority, "P2 - High", 2, 30, 480]
  );
});

afterAll(async () => {
  await db.close();
});

describe("POST /api/incidents", () => {
  it("creates an incident in 'new' status with a computed due_at", async () => {
    const res = await request(app).post("/api/incidents").send({
      title: "Printer not working",
      description: "3rd floor printer offline",
      reporterId: reporter,
      categoryId: category,
      priorityId: priority,
      teamId: team,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("new");
    expect(res.body.title).toBe("Printer not working");
    expect(res.body.due_at).toBeTruthy();
    expect(new Date(res.body.due_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app).post("/api/incidents").send({ title: "Missing stuff" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/required/);
  });

  it("returns 400 for an unknown priorityId", async () => {
    const res = await request(app).post("/api/incidents").send({
      title: "Bad priority",
      reporterId: reporter,
      categoryId: category,
      priorityId: "not-a-real-id",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Unknown priorityId/);
  });
});

describe("PATCH /api/incidents/:id/assignment", () => {
  let incidentId;

  beforeEach(async () => {
    const res = await request(app).post("/api/incidents").send({
      title: "VPN down",
      reporterId: reporter,
      categoryId: category,
      priorityId: priority,
    });
    incidentId = res.body.id;
  });

  it("assigns the incident and advances status from 'new' to 'assigned'", async () => {
    const res = await request(app)
      .patch(`/api/incidents/${incidentId}/assignment`)
      .send({ assignedTo: agent, assignedBy: agent, reason: "self-claim" });

    expect(res.status).toBe(200);
    expect(res.body.assignee_id).toBe(agent);
    expect(res.body.status).toBe("assigned");
  });

  it("reassignment closes the old assignment row and opens a new one", async () => {
    await request(app)
      .patch(`/api/incidents/${incidentId}/assignment`)
      .send({ assignedTo: agent, assignedBy: agent });

    await request(app)
      .patch(`/api/incidents/${incidentId}/assignment`)
      .send({ assignedTo: otherAgent, assignedBy: agent, reason: "handoff" });

    const getRes = await request(app).get(`/api/incidents/${incidentId}`);
    expect(getRes.body.assignee_id).toBe(otherAgent);
    expect(getRes.body.assignments).toHaveLength(2);
    expect(getRes.body.assignments[0].unassigned_at).toBeTruthy();
    expect(getRes.body.assignments[1].unassigned_at).toBeNull();
  });

  it("returns 400 for an unknown assignedTo user", async () => {
    const res = await request(app)
      .patch(`/api/incidents/${incidentId}/assignment`)
      .send({ assignedTo: "not-a-real-user" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/incidents/:id/status", () => {
  let incidentId;

  beforeEach(async () => {
    const res = await request(app).post("/api/incidents").send({
      title: "Email outage",
      reporterId: reporter,
      categoryId: category,
      priorityId: priority,
    });
    incidentId = res.body.id;
    await request(app)
      .patch(`/api/incidents/${incidentId}/assignment`)
      .send({ assignedTo: agent, assignedBy: agent });
  });

  it("walks assigned -> in_progress -> resolved, stamping resolved_at", async () => {
    await request(app)
      .patch(`/api/incidents/${incidentId}/status`)
      .send({ status: "in_progress", changedBy: agent });

    const res = await request(app)
      .patch(`/api/incidents/${incidentId}/status`)
      .send({ status: "resolved", changedBy: agent, note: "Fixed mail server" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolved_at).toBeTruthy();
    expect(res.body.closed_at).toBeNull();
  });

  it("stamps closed_at when moving to closed", async () => {
    await request(app).patch(`/api/incidents/${incidentId}/status`).send({ status: "in_progress", changedBy: agent });
    await request(app).patch(`/api/incidents/${incidentId}/status`).send({ status: "resolved", changedBy: agent });

    const res = await request(app)
      .patch(`/api/incidents/${incidentId}/status`)
      .send({ status: "closed", changedBy: agent });

    expect(res.body.status).toBe("closed");
    expect(res.body.closed_at).toBeTruthy();
  });

  it("rejects an invalid transition (assigned -> resolved) with 409", async () => {
    const res = await request(app)
      .patch(`/api/incidents/${incidentId}/status`)
      .send({ status: "resolved", changedBy: agent });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Cannot move incident/);
  });

  it("clears resolved_at on reopen from resolved back to in_progress", async () => {
    await request(app).patch(`/api/incidents/${incidentId}/status`).send({ status: "in_progress", changedBy: agent });
    await request(app).patch(`/api/incidents/${incidentId}/status`).send({ status: "resolved", changedBy: agent });

    const res = await request(app)
      .patch(`/api/incidents/${incidentId}/status`)
      .send({ status: "in_progress", changedBy: agent, note: "Issue recurred" });

    expect(res.body.status).toBe("in_progress");
    expect(res.body.resolved_at).toBeNull();
  });

  it("logs every transition to statusHistory, visible via GET", async () => {
    await request(app).patch(`/api/incidents/${incidentId}/status`).send({ status: "in_progress", changedBy: agent });
    await request(app).patch(`/api/incidents/${incidentId}/status`).send({ status: "resolved", changedBy: agent });

    const res = await request(app).get(`/api/incidents/${incidentId}`);
    const toStatuses = res.body.statusHistory.map((h) => h.to_status);
    expect(toStatuses).toEqual(["new", "assigned", "in_progress", "resolved"]);
  });
});

describe("GET /api/incidents/:id", () => {
  it("returns 404 for an unknown incident", async () => {
    const res = await request(app).get("/api/incidents/not-a-real-id");
    expect(res.status).toBe(404);
  });
});
