const request = require("supertest");
const { installClock, bootstrap, makeApi, rawIncident, snapshot, db, HOUR } = require("./helpers/lifecycleHarness");
const auditService = require("../src/services/auditService");
const { runEscalationCycle } = require("../src/services/escalationService");

let ctx, ids, api, time;

beforeAll(async () => {
  time = installClock();
  ctx = await bootstrap();
  ids = ctx.ids;
  api = makeApi(ctx, time);
});

afterAll(async () => {
  time.restore();
  await db.close();
});

// Direct reads, so assertions don't depend on the read API under test.
const rows = async (incidentId) =>
  (await db.query("SELECT * FROM audit_log WHERE incident_id = ? ORDER BY occurred_at, id", [incidentId])).rows;
const totalRows = async () => (await db.query("SELECT COUNT(*) AS n FROM audit_log")).rows[0].n;
const actions = async (incidentId) => (await rows(incidentId)).map((r) => r.action);

describe("what gets recorded", () => {
  it("creating an incident records who, what and when, with every initial field", async () => {
    time.advance();
    const res = await api.create({ title: "Audit create", teamId: ids.team });
    expect(res.status).toBe(201);

    const entries = await rows(res.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "incident.created",
      entity_type: "incident",
      entity_id: res.body.id,
      incident_id: res.body.id,
      actor_id: ids.reporter,
      occurred_at: time.iso(),
    });
    expect(JSON.parse(entries[0].changes)).toEqual({
      title: { from: null, to: "Audit create" },
      status: { from: null, to: "new" },
      reporter_id: { from: null, to: ids.reporter },
      team_id: { from: null, to: ids.team },
      category_id: { from: null, to: ids.category },
      priority_id: { from: null, to: ids.priority },
      due_at: { from: null, to: res.body.due_at },
    });
  });

  it("the first assignment records the assignee and the new -> assigned move, with the reason", async () => {
    const id = await api.newIncidentIn("new");
    time.advance();
    await api.assign(id, { reason: "self-claim" });

    const entries = await rows(id);
    expect(entries.map((e) => e.action)).toEqual(["incident.created", "incident.assigned"]);
    const entry = entries[1];
    expect(entry).toMatchObject({ actor_id: ids.agent, occurred_at: time.iso() });
    expect(JSON.parse(entry.changes)).toEqual({
      status: { from: "new", to: "assigned" },
      assignee_id: { from: null, to: ids.agent },
    });
    expect(JSON.parse(entry.metadata).reason).toBe("self-claim");
  });

  it("a reassignment is its own action and records only the assignee change", async () => {
    const id = await api.newIncidentIn("in_progress");
    time.advance();
    await api.assign(id, { to: ids.agent2, by: ids.agent2, reason: "handoff" });

    const last = (await rows(id)).pop();
    expect(last.action).toBe("incident.reassigned");
    expect(last.actor_id).toBe(ids.agent2);
    expect(JSON.parse(last.changes)).toEqual({ assignee_id: { from: ids.agent, to: ids.agent2 } });
  });

  it("a system assignment (no assignedBy) is recorded with a null actor", async () => {
    const id = await api.newIncidentIn("new");
    time.advance();
    await api.assign(id, { omitBy: true });
    expect((await rows(id)).pop().actor_id).toBeNull();
  });

  it("each status change records the move, the actor and the note", async () => {
    const id = await api.newIncidentIn("assigned");
    time.advance();
    await api.setStatus(id, "in_progress", { by: ids.agent2, note: "Picking this up" });
    time.advance();
    await api.setStatus(id, "resolved");

    const [, , started, resolved] = await rows(id);
    expect(started).toMatchObject({ action: "incident.status_changed", actor_id: ids.agent2 });
    expect(JSON.parse(started.changes)).toEqual({ status: { from: "assigned", to: "in_progress" } });
    expect(JSON.parse(started.metadata).note).toBe("Picking this up");

    expect(resolved.action).toBe("incident.status_changed");
    expect(JSON.parse(resolved.changes)).toEqual({
      status: { from: "in_progress", to: "resolved" },
      resolved_at: { from: null, to: resolved.occurred_at },
    });
    expect(JSON.parse(resolved.metadata).note).toBeUndefined();
  });

  it("a full journey leaves one audit row per successful action, in order", async () => {
    const id = await api.newIncidentIn("closed");
    expect(await actions(id)).toEqual([
      "incident.created",
      "incident.assigned",
      "incident.status_changed",
      "incident.status_changed",
      "incident.status_changed",
    ]);
  });

  it("reopening is recorded as its own action and shows the cleared timestamps", async () => {
    const id = await api.newIncidentIn("closed");
    time.advance();
    await api.setStatus(id, "in_progress", { note: "recurred" });

    const last = (await rows(id)).pop();
    expect(last.action).toBe("incident.reopened");
    const changes = JSON.parse(last.changes);
    expect(changes.status).toEqual({ from: "closed", to: "in_progress" });
    expect(changes.resolved_at.to).toBeNull();
    expect(changes.closed_at.to).toBeNull();
    expect(changes.resolved_at.from).not.toBeNull();
  });

  it("an automatic escalation is recorded as a system action with the priorities and reason", async () => {
    const id = await api.newIncidentIn("in_progress");
    const created = (await rawIncident(id)).created_at;
    const now = new Date(Date.parse(created) + 20 * HOUR);

    await runEscalationCycle({ now });

    const last = (await rows(id)).pop();
    expect(last).toMatchObject({ action: "incident.escalated", actor_id: null, occurred_at: now.toISOString() });
    expect(JSON.parse(last.changes)).toEqual({ priority_id: { from: ids.priorities[3], to: ids.priorities[2] } });
    expect(JSON.parse(last.metadata)).toMatchObject({
      automatic: true,
      from_priority: "P3 - Medium",
      to_priority: "P2 - High",
    });
  });

  it("a dry-run escalation writes nothing", async () => {
    const id = await api.newIncidentIn("in_progress");
    const created = (await rawIncident(id)).created_at;
    const before = await totalRows();

    const result = await runEscalationCycle({ now: new Date(Date.parse(created) + 20 * HOUR), dryRun: true });

    expect(result.escalated.map((e) => e.incident_id)).toContain(id);
    expect(await totalRows()).toBe(before);
  });
});

describe("what is not recorded", () => {
  it("rejected requests write no audit rows", async () => {
    const id = await api.newIncidentIn("new");
    const before = await totalRows();

    time.advance();
    expect((await api.setStatus(id, "resolved")).status).toBe(409); // illegal move
    expect((await api.setStatus(id, "assigned")).status).toBe(409); // must use the assignment endpoint
    expect((await api.setStatus(id, "nonsense")).status).toBe(400);
    expect((await api.setStatus(id, "in_progress", { by: "nobody" })).status).toBe(400);
    expect((await api.assign(id, { to: undefined })).status).toBe(400);
    expect((await api.create({ title: undefined })).status).toBe(400);
    expect((await api.setStatus("missing-id", "in_progress")).status).toBe(404);

    expect(await totalRows()).toBe(before);
  });

  it("rejecting an assignment of a closed incident writes nothing", async () => {
    const id = await api.newIncidentIn("closed");
    const before = await totalRows();
    time.advance();
    expect((await api.assign(id, { to: ids.agent2 })).status).toBe(409);
    expect(await totalRows()).toBe(before);
  });

  it("reading incidents writes nothing", async () => {
    const id = await api.newIncidentIn("new");
    const before = await totalRows();
    await api.get(id);
    await request(ctx.app).get("/api/incidents");
    await request(ctx.app).get("/api/audit-logs");
    expect(await totalRows()).toBe(before);
  });
});

describe("atomicity: an action and its audit row succeed or fail together", () => {
  let consoleError;
  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  async function withAuditLogOffline(fn) {
    await db.query("ALTER TABLE audit_log RENAME TO audit_log_offline");
    try {
      return await fn();
    } finally {
      await db.query("ALTER TABLE audit_log_offline RENAME TO audit_log");
    }
  }

  it("a status change is rolled back if its audit row cannot be written", async () => {
    const id = await api.newIncidentIn("assigned");
    const before = await snapshot(id);

    const res = await withAuditLogOffline(async () => {
      time.advance();
      return api.setStatus(id, "in_progress");
    });

    expect(res.status).toBe(500);
    expect(await snapshot(id)).toEqual(before);
  });

  it("an assignment is rolled back if its audit row cannot be written", async () => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);

    const res = await withAuditLogOffline(async () => {
      time.advance();
      return api.assign(id);
    });

    expect(res.status).toBe(500);
    expect(await snapshot(id)).toEqual(before);
  });

  it("a creation is rolled back if its audit row cannot be written", async () => {
    const before = (await db.query("SELECT COUNT(*) AS n FROM incidents")).rows[0].n;

    const res = await withAuditLogOffline(async () => {
      time.advance();
      return api.create();
    });

    expect(res.status).toBe(500);
    expect((await db.query("SELECT COUNT(*) AS n FROM incidents")).rows[0].n).toBe(before);
  });

  it("an escalation is rolled back if its audit row cannot be written, and the cycle reports it", async () => {
    const id = await api.newIncidentIn("in_progress");
    const created = (await rawIncident(id)).created_at;

    const result = await withAuditLogOffline(() =>
      runEscalationCycle({ now: new Date(Date.parse(created) + 20 * HOUR) })
    );

    expect(result.errors.map((e) => e.incident_id)).toContain(id);
    expect((await rawIncident(id)).priority_id).toBe(ids.priority);
    expect((await db.query("SELECT * FROM incident_escalations WHERE incident_id = ?", [id])).rows).toHaveLength(0);
  });

  it("the audit service itself refuses an unknown action", () => {
    expect(() =>
      auditService.record(jest.fn(), { action: "incident.exploded", entityType: "incident", entityId: "x" })
    ).toThrow(/unknown action/);
  });
});

describe("request context", () => {
  it("stamps the request id and user agent on the audit row, and echoes the id back", async () => {
    time.advance();
    const res = await request(ctx.app)
      .post("/api/incidents")
      .set("X-Request-Id", "req-123")
      .set("User-Agent", "jest-agent")
      .send({ title: "ctx", reporterId: ids.reporter, categoryId: ids.category, priorityId: ids.priority });

    expect(res.status).toBe(201);
    expect(res.headers["x-request-id"]).toBe("req-123");

    const metadata = JSON.parse((await rows(res.body.id))[0].metadata);
    expect(metadata).toMatchObject({ requestId: "req-123", userAgent: "jest-agent" });
    expect(metadata.ip).toBeTruthy();
  });

  it("generates a request id when the client sends none", async () => {
    const res = await request(ctx.app).get("/api/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("trims an over-long client request id", async () => {
    const res = await request(ctx.app).get("/api/health").set("X-Request-Id", "a".repeat(500));
    expect(res.headers["x-request-id"]).toHaveLength(100);
  });

  it("two simultaneous requests keep their own context", async () => {
    time.advance();
    const send = (requestId, title) =>
      request(ctx.app)
        .post("/api/incidents")
        .set("X-Request-Id", requestId)
        .send({ title, reporterId: ids.reporter, categoryId: ids.category, priorityId: ids.priority });

    const [a, b] = await Promise.all([send("req-a", "ctx A"), send("req-b", "ctx B")]);

    expect(JSON.parse((await rows(a.body.id))[0].metadata).requestId).toBe("req-a");
    expect(JSON.parse((await rows(b.body.id))[0].metadata).requestId).toBe("req-b");
  });

  it("an action taken outside a request has no request metadata", async () => {
    const incidentService = require("../src/services/incidentService");
    time.advance();
    const incident = await incidentService.createIncident({
      title: "from a script",
      reporterId: ids.reporter,
      categoryId: ids.category,
      priorityId: ids.priority,
    });
    expect((await rows(incident.id))[0].metadata).toBeNull();
  });
});

describe("the log is append-only", () => {
  it("the audit service exposes no way to change or remove rows", () => {
    expect(Object.keys(auditService).sort()).toEqual(["list", "listForIncident", "record"]);
    Object.keys(auditService).forEach((name) => expect(name).not.toMatch(/update|delete|remove|purge|edit/i));
  });
});

describe("GET /api/audit-logs", () => {
  let id;
  beforeAll(async () => {
    id = await api.newIncidentIn("in_progress");
  });

  const get = (query) => request(ctx.app).get(`/api/audit-logs${query}`);

  it("returns an incident's entries newest first, with the actor's name and parsed JSON", async () => {
    const res = await get(`?incidentId=${id}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.action)).toEqual([
      "incident.status_changed",
      "incident.assigned",
      "incident.created",
    ]);
    expect(res.body.items[0]).toMatchObject({ actor_name: "Amara Agent" });
    expect(res.body.items[0].changes.status).toEqual({ from: "assigned", to: "in_progress" });
    expect(res.body.items[2].actor_name).toBe("Riley Requester");
    expect(res.body).toMatchObject({ limit: 50, offset: 0 });
  });

  it("can return oldest first", async () => {
    const res = await get(`?incidentId=${id}&order=asc`);
    expect(res.body.items[0].action).toBe("incident.created");
  });

  it("filters by action", async () => {
    const res = await get(`?incidentId=${id}&action=incident.assigned`);
    expect(res.body.items).toHaveLength(1);
  });

  it("filters by actor", async () => {
    const res = await get(`?incidentId=${id}&actorId=${ids.reporter}`);
    expect(res.body.items.map((i) => i.action)).toEqual(["incident.created"]);
  });

  it("filters by entity", async () => {
    const res = await get(`?entityType=incident&entityId=${id}`);
    expect(res.body.items).toHaveLength(3);
    expect((await get("?entityType=user")).body.items).toEqual([]);
  });

  it("filters by time range, both ends inclusive", async () => {
    const all = (await get(`?incidentId=${id}&order=asc`)).body.items;
    const [first, second] = all;

    const onlyFirst = await get(`?incidentId=${id}&from=${first.occurred_at}&to=${first.occurred_at}`);
    expect(onlyFirst.body.items.map((i) => i.id)).toEqual([first.id]);

    const fromSecond = await get(`?incidentId=${id}&from=${encodeURIComponent(second.occurred_at)}`);
    expect(fromSecond.body.items).toHaveLength(2);

    const none = await get(`?incidentId=${id}&to=2000-01-01`);
    expect(none.body.items).toEqual([]);
  });

  it("pages with limit and offset", async () => {
    const page = await get(`?incidentId=${id}&limit=1&offset=1`);
    expect(page.body.items.map((i) => i.action)).toEqual(["incident.assigned"]);
    expect(page.body).toMatchObject({ limit: 1, offset: 1 });
  });

  test.each([
    ["limit=0", /Invalid limit/],
    ["limit=-5", /Invalid limit/],
    ["limit=abc", /Invalid limit/],
    ["limit=1.5", /Invalid limit/],
    ["limit=201", /Invalid limit/],
    ["offset=-1", /Invalid offset/],
    ["offset=abc", /Invalid offset/],
    ["from=garbage", /Invalid from/],
    ["to=garbage", /Invalid to/],
    ["action=incident.exploded", /Invalid action/],
    ["order=sideways", /Invalid order/],
  ])("rejects %s with 400", async (query, message) => {
    const res = await get(`?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(message);
  });
});

describe("GET /api/incidents/:id/audit", () => {
  it("returns that incident's trail oldest first, and nobody else's", async () => {
    const id = await api.newIncidentIn("resolved");
    const other = await api.newIncidentIn("new");

    const res = await request(ctx.app).get(`/api/incidents/${id}/audit`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.action)).toEqual([
      "incident.created",
      "incident.assigned",
      "incident.status_changed",
      "incident.status_changed",
    ]);
    res.body.items.forEach((i) => expect(i.incident_id).toBe(id));
    expect(res.body.items.map((i) => i.incident_id)).not.toContain(other);
  });

  it("can be reversed and paged", async () => {
    const id = await api.newIncidentIn("resolved");
    const res = await request(ctx.app).get(`/api/incidents/${id}/audit?order=desc&limit=1`);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].action).toBe("incident.status_changed");
  });

  it("returns 404 for an unknown incident", async () => {
    const res = await request(ctx.app).get("/api/incidents/not-a-real-id/audit");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Incident not found/);
  });
});