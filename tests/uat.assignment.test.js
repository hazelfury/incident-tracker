// User acceptance tests for the assignment workflow.
//
// These read as the scenarios a person would walk through: a requester reports
// an incident, a manager or agent picks it up, hands it over, works it, and so
// on. Each test goes through the real HTTP API and database, the way the
// dashboard's users and the rest of the system would. Scenario ids (UAT-A..)
// match docs/UAT_ASSIGNMENT.md.

const crypto = require("crypto");
const request = require("supertest");
const { installClock, bootstrap, makeApi, snapshot, rawIncident, db } = require("./helpers/lifecycleHarness");

let ctx, ids, api, time;
let manager;

beforeAll(async () => {
  time = installClock();
  ctx = await bootstrap();
  ids = ctx.ids;
  api = makeApi(ctx, time);

  manager = crypto.randomUUID();
  await db.query("INSERT INTO users (id, name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)", [
    manager,
    "Morgan Manager",
    "morgan@example.com",
    "hash",
    "manager",
    ids.team,
  ]);
});

afterAll(async () => {
  time.restore();
  await db.close();
});

// A request with an arbitrary body, for malformed-input scenarios.
const rawAssign = (id, body) => request(ctx.app).patch(`/api/incidents/${id}/assignment`).send(body);
const auditActions = async (id) =>
  (await request(ctx.app).get(`/api/incidents/${id}/audit`)).body.items.map((item) => item.action);
const auditCount = async (id) =>
  (await db.query("SELECT COUNT(*) AS n FROM audit_log WHERE incident_id = ?", [id])).rows[0].n;

describe("UAT-A01: report, claim, work and close an incident", () => {
  it("leaves one assignment, a complete history, a met response SLA and a full audit trail", async () => {
    time.advance();
    const created = await api.create({ title: "UAT happy path" });
    const id = created.body.id;

    time.advance(10);
    expect((await api.assign(id, { reason: "self-claim" })).status).toBe(200);
    for (const step of ["in_progress", "resolved", "closed"]) {
      expect([step, (await api.step(id, step)).status]).toEqual([step, 200]);
    }

    const detail = (await api.get(id)).body;
    expect(detail.status).toBe("closed");
    expect(detail.assignments).toHaveLength(1);
    expect(detail.assignments[0]).toMatchObject({
      assigned_to: ids.agent,
      assigned_to_name: "Amara Agent",
      reason: "self-claim",
      unassigned_at: null,
    });
    expect(detail.statusHistory.map((h) => h.to_status)).toEqual([
      "new",
      "assigned",
      "in_progress",
      "resolved",
      "closed",
    ]);
    expect(detail.sla.response.status).toBe("met");
    expect(await auditActions(id)).toEqual([
      "incident.created",
      "incident.assigned",
      "incident.status_changed",
      "incident.status_changed",
      "incident.status_changed",
    ]);
  });
});

describe("UAT-A02: a manager assigns an incident and then hands it to someone else", () => {
  it("keeps one open assignment, closes the first, and shows who assigned whom", async () => {
    const id = await api.newIncidentIn("new");

    time.advance();
    expect((await api.assign(id, { to: ids.agent, by: manager })).status).toBe(200);
    time.advance();
    const handoff = await api.assign(id, { to: ids.agent2, by: manager, reason: "handoff" });
    expect(handoff.status).toBe(200);
    expect(handoff.body).toMatchObject({ assignee_id: ids.agent2, status: "assigned" });

    const detail = (await api.get(id)).body;
    expect(detail.assignee_name).toBe("Omar Agent");
    expect(detail.assignments).toHaveLength(2);
    expect(detail.assignments[0]).toMatchObject({ assigned_by_name: "Morgan Manager" });
    expect(detail.assignments[0].unassigned_at).toBeTruthy();
    expect(detail.assignments[1]).toMatchObject({ assigned_to_name: "Omar Agent", unassigned_at: null });

    const actions = await auditActions(id);
    expect(actions.slice(-2)).toEqual(["incident.assigned", "incident.reassigned"]);
  });

  it("lets a manager be the one who works the incident", async () => {
    const id = await api.newIncidentIn("new");
    time.advance();
    const res = await api.assign(id, { to: manager, by: manager });
    expect(res.status).toBe(200);
    expect(res.body.assignee_id).toBe(manager);
  });
});

describe("UAT-A03: requesters cannot take part in assignment", () => {
  it("refuses to assign an incident to a requester", async () => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);

    time.advance();
    const res = await api.assign(id, { to: ids.reporter });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/assignedTo must be an agent, manager or admin.*requester/);
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses an assignment made by a requester", async () => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);
    const auditBefore = await auditCount(id);

    time.advance();
    const res = await api.assign(id, { to: ids.agent, by: ids.reporter });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/assignedBy must be an agent, manager or admin.*requester/);
    expect(await snapshot(id)).toEqual(before);
    expect(await auditCount(id)).toBe(auditBefore);
  });

  it("does not let a requester reassign an incident that is already assigned", async () => {
    const id = await api.newIncidentIn("in_progress");
    const before = await snapshot(id);
    time.advance();
    const res = await api.assign(id, { to: ids.agent2, by: ids.reporter });
    expect(res.status).toBe(400);
    expect(await snapshot(id)).toEqual(before);
  });
});

describe("UAT-A04: pressing assign twice does no harm", () => {
  it("assigning to the current assignee changes nothing: no new assignment, history, audit row or timestamp", async () => {
    const id = await api.newIncidentIn("in_progress");
    const before = await snapshot(id);
    const auditBefore = await auditCount(id);

    time.advance(30);
    const res = await api.assign(id, { to: ids.agent, reason: "again" });

    expect(res.status).toBe(200);
    expect(res.body.assignee_id).toBe(ids.agent);
    expect(await snapshot(id)).toEqual(before); // assigned_at did not move either
    expect(await auditCount(id)).toBe(auditBefore);
  });

  it("two simultaneous assignments to the same person leave exactly one assignment", async () => {
    const id = await api.newIncidentIn("new");

    time.advance();
    const results = await Promise.all([api.assign(id, { to: ids.agent }), api.assign(id, { to: ids.agent })]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const { assignments, history } = await snapshot(id);
    expect(assignments).toHaveLength(1);
    expect(history.filter((h) => h.to_status === "assigned")).toHaveLength(1);
    expect(await auditActions(id)).toEqual(["incident.created", "incident.assigned"]);
  });

  it("still refuses to assign a closed incident, even to its current assignee", async () => {
    const id = await api.newIncidentIn("closed");
    time.advance();
    expect((await api.assign(id, { to: ids.agent })).status).toBe(409);
  });
});

describe("UAT-A05: bad input gets a clear 400, never a server error, and writes nothing", () => {
  const bad = [
    ["assignedTo is an object", { assignedTo: { id: "x" } }, /assignedTo must be a user id/],
    ["assignedTo is an array", { assignedTo: ["x"] }, /assignedTo must be a user id/],
    ["assignedTo is a number", { assignedTo: 123 }, /assignedTo must be a user id/],
    ["assignedTo is blank", { assignedTo: "" }, /assignedTo is required/],
    ["assignedBy is an object", { assignedTo: "AGENT", assignedBy: { id: "x" } }, /assignedBy must be a user id/],
    ["reason is an object", { assignedTo: "AGENT", reason: { text: "x" } }, /reason must be text/],
    ["reason is too long", { assignedTo: "AGENT", reason: "x".repeat(501) }, /500 characters or fewer/],
    ["assignedTo does not exist", { assignedTo: "not-a-user" }, /Unknown assignedTo/],
    ["assignedBy does not exist", { assignedTo: "AGENT", assignedBy: "not-a-user" }, /Unknown assignedBy/],
  ];

  test.each(bad)("%s", async (_label, body, message) => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);
    const auditBefore = await auditCount(id);
    const filled = JSON.parse(JSON.stringify(body).replace('"AGENT"', JSON.stringify(ids.agent)));

    const res = await rawAssign(id, filled);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(message);
    expect(await snapshot(id)).toEqual(before);
    expect(await auditCount(id)).toBe(auditBefore);
  });

  it("keeps the reason tidy: surrounding spaces are trimmed and a blank reason is stored as nothing", async () => {
    const first = await api.newIncidentIn("new");
    time.advance();
    await api.assign(first, { reason: "  needs VPN access  " });
    expect((await snapshot(first)).assignments[0].reason).toBe("needs VPN access");

    const second = await api.newIncidentIn("new");
    time.advance();
    await api.assign(second, { reason: "   " });
    expect((await snapshot(second)).assignments[0].reason).toBeNull();
  });

  it("answers 404 for an unknown incident", async () => {
    const res = await api.assign(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});

describe("UAT-A06: closed and cancelled incidents; reopening makes assignment possible again", () => {
  test.each(["closed", "cancelled"])("a %s incident cannot be assigned", async (status) => {
    const id = await api.newIncidentIn(status);
    const before = await snapshot(id);
    time.advance();
    const res = await api.assign(id, { to: ids.agent2 });
    expect(res.status).toBe(409);
    expect(await snapshot(id)).toEqual(before);
  });

  it("a closed incident can be reopened and then handed to someone new", async () => {
    const id = await api.newIncidentIn("closed");
    time.advance();
    expect((await api.setStatus(id, "in_progress")).status).toBe(200);

    time.advance();
    const res = await api.assign(id, { to: ids.agent2 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "in_progress", assignee_id: ids.agent2 });
  });
});

describe("UAT-A07: assigning an incident that is on hold", () => {
  it("changes the assignee but leaves it on hold with its SLA clock still paused", async () => {
    const id = await api.newIncidentIn("on_hold");

    time.advance();
    const res = await api.assign(id, { to: ids.agent2, reason: "covering" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "on_hold", assignee_id: ids.agent2 });
    const detail = (await api.get(id)).body;
    expect(detail.sla.resolution.status).toBe("paused");
    expect(detail.statusHistory[detail.statusHistory.length - 1].to_status).toBe("on_hold");
  });
});

describe("UAT-A08: the response SLA is decided by the first assignment only", () => {
  it("stays 'met' after a later handoff", async () => {
    time.advance();
    const created = await api.create(); // P3: 120 minute response target
    const id = created.body.id;

    time.advance(30);
    await api.assign(id, { to: ids.agent });
    const first = (await api.get(id)).body.sla.response;
    expect(first.status).toBe("met");

    time.advance(24 * 60);
    await api.assign(id, { to: ids.agent2 });
    const later = (await api.get(id)).body.sla.response;

    expect(later.status).toBe("met");
    expect(later.responded_at).toBe(first.responded_at);
  });

  it("is breached when nobody takes the incident within the target", async () => {
    time.advance();
    const created = await api.create();
    time.advance(121);
    const res = await api.assign(created.body.id);
    expect(res.status).toBe(200);
    expect((await api.get(created.body.id)).body.sla.response.status).toBe("breached");
  });
});

describe("UAT-A09: the incident list reflects assignment", () => {
  it("shows the assignee's name once assigned, and none before", async () => {
    const id = await api.newIncidentIn("new");
    const find = async () => (await request(ctx.app).get("/api/incidents")).body.find((row) => row.id === id);

    expect((await find()).assignee_name).toBeNull();

    time.advance();
    await api.assign(id, { to: ids.agent });
    expect((await find()).assignee_name).toBe("Amara Agent");

    time.advance();
    await api.assign(id, { to: ids.agent2 });
    expect((await find()).assignee_name).toBe("Omar Agent");
  });

  it("an incident cannot leave 'new' without an assignee", async () => {
    const id = await api.newIncidentIn("new");
    time.advance();
    expect((await api.setStatus(id, "in_progress")).status).toBe(409);
    expect((await rawIncident(id)).assignee_id).toBeNull();
  });
});