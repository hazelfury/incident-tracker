const crypto = require("crypto");
const {
  HOUR,
  MINUTE,
  installClock,
  bootstrap,
  makeApi,
  rawIncident,
  snapshot,
  db,
} = require("./helpers/lifecycleHarness");
const {
  SPEC_STATUSES,
  SPEC_TRANSITIONS,
  statusEndpointAllows,
  assignAllowed,
} = require("./helpers/lifecycleSpec");
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

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("creating an incident", () => {
  it("starts in 'new' with nothing assigned, resolved or closed, and one history row", async () => {
    time.advance();
    const res = await api.create({ title: "Creation check" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "new",
      assignee_id: null,
      assigned_at: null,
      resolved_at: null,
      closed_at: null,
      created_at: time.iso(),
    });

    const { history, assignments } = await snapshot(res.body.id);
    expect(assignments).toHaveLength(0);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_status: null,
      to_status: "new",
      changed_by: ids.reporter,
      changed_at: time.iso(),
    });
  });

  it("sets the resolution deadline from the priority's SLA (P3 = 24h)", async () => {
    time.advance();
    const res = await api.create();
    const due = Date.parse(res.body.due_at) - Date.parse(res.body.created_at);
    expect(due).toBe(24 * HOUR);
  });

  test.each([
    ["reporterId", /Unknown reporterId/],
    ["categoryId", /Unknown categoryId/],
    ["teamId", /Unknown teamId/],
    ["priorityId", /Unknown priorityId/],
  ])("rejects an unknown %s with 400 and creates nothing", async (field, message) => {
    const before = (await db.query("SELECT COUNT(*) AS n FROM incidents")).rows[0].n;

    time.advance();
    const res = await api.create({ [field]: crypto.randomUUID() });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(message);
    expect((await db.query("SELECT COUNT(*) AS n FROM incidents")).rows[0].n).toBe(before);
  });

  test.each([["title"], ["reporterId"], ["categoryId"], ["priorityId"]])(
    "rejects a missing %s with 400",
    async (field) => {
      time.advance();
      const res = await api.create({ [field]: undefined });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/required/);
    }
  );

  it("uses a shorter deadline for a higher priority (P1 = 4h)", async () => {
    time.advance();
    const res = await api.create({ priorityId: ids.priorities[1] });
    expect(Date.parse(res.body.due_at) - Date.parse(res.body.created_at)).toBe(4 * HOUR);
  });
});

// ---------------------------------------------------------------------------
// Every (from, to) pair through the status endpoint
// ---------------------------------------------------------------------------

describe("status endpoint: all 49 from/to combinations", () => {
  const pairs = SPEC_STATUSES.flatMap((from) => SPEC_STATUSES.map((to) => [from, to]));

  test.each(pairs)("%s -> %s", async (from, to) => {
    const id = await api.newIncidentIn(from);
    const before = await snapshot(id);

    time.advance();
    const res = await api.setStatus(id, to, { note: `${from} to ${to}` });
    const after = await snapshot(id);

    if (statusEndpointAllows(from, to)) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(to);
      expect(after.incident.status).toBe(to);
      expect(after.history).toHaveLength(before.history.length + 1);
      expect(after.history[after.history.length - 1]).toMatchObject({
        from_status: from,
        to_status: to,
        changed_by: ids.agent,
        changed_at: time.iso(),
        note: `${from} to ${to}`,
      });
      return;
    }

    expect(res.status).toBe(409);
    if (from === "new" && to === "assigned") {
      // In the table, but only the assignment endpoint may do it.
      expect(res.body.error.message).toMatch(/assignment/);
    } else {
      expect(res.body.error.message).toContain(`Cannot move incident from "${from}" to "${to}"`);
      const allowed = SPEC_TRANSITIONS[from];
      if (allowed.length === 0) expect(res.body.error.message).toContain("none (terminal state)");
      allowed.forEach((next) => expect(res.body.error.message).toContain(next));
    }

    // A rejected transition leaves no trace at all.
    expect(after.incident).toEqual(before.incident);
    expect(after.history).toEqual(before.history);
    expect(after.assignments).toEqual(before.assignments);
  });
});

// ---------------------------------------------------------------------------
// Whole journeys
// ---------------------------------------------------------------------------

describe("lifecycle paths", () => {
  const A = "assign";
  const paths = [
    { name: "straight through", steps: [A, "in_progress", "resolved", "closed"], final: "closed", resolved: true, closed: true },
    { name: "with a hold", steps: [A, "in_progress", "on_hold", "in_progress", "resolved"], final: "resolved", resolved: true, closed: false },
    { name: "with two holds", steps: [A, "in_progress", "on_hold", "in_progress", "on_hold", "in_progress", "resolved", "closed"], final: "closed", resolved: true, closed: true },
    { name: "reopened from resolved", steps: [A, "in_progress", "resolved", "in_progress", "resolved", "closed"], final: "closed", resolved: true, closed: true },
    { name: "reopened from closed", steps: [A, "in_progress", "resolved", "closed", "in_progress", "resolved", "closed"], final: "closed", resolved: true, closed: true },
    { name: "reopened and left open", steps: [A, "in_progress", "resolved", "closed", "in_progress"], final: "in_progress", resolved: false, closed: false },
    { name: "put on hold and left there", steps: [A, "in_progress", "on_hold"], final: "on_hold", resolved: false, closed: false },
    { name: "cancelled straight away", steps: ["cancelled"], final: "cancelled", resolved: false, closed: false },
    { name: "cancelled once assigned", steps: [A, "cancelled"], final: "cancelled", resolved: false, closed: false },
    { name: "cancelled while in progress", steps: [A, "in_progress", "cancelled"], final: "cancelled", resolved: false, closed: false },
  ];

  test.each(paths)("$name", async ({ steps, final, resolved, closed }) => {
    time.advance();
    const created = await api.create();
    const id = created.body.id;

    for (const step of steps) {
      const res = await api.step(id, step);
      expect([step, res.status]).toEqual([step, 200]);
    }

    const { incident, history } = await snapshot(id);
    const expectedTo = ["new", ...steps.map((s) => (s === A ? "assigned" : s))];

    expect(incident.status).toBe(final);
    expect(history.map((h) => h.to_status)).toEqual(expectedTo);

    // Each row starts where the previous one ended.
    expect(history[0].from_status).toBeNull();
    for (let i = 1; i < history.length; i++) {
      expect([i, history[i].from_status]).toEqual([i, history[i - 1].to_status]);
    }

    expect(incident.resolved_at !== null).toBe(resolved);
    expect(incident.closed_at !== null).toBe(closed);
  });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

describe("lifecycle timestamps", () => {
  it("stamps resolved_at and closed_at with the moment of each transition, and keeps resolved_at on close", async () => {
    const id = await api.newIncidentIn("in_progress");

    time.advance(30);
    const resolvedAt = time.iso();
    await api.setStatus(id, "resolved");
    let row = await rawIncident(id);
    expect(row.resolved_at).toBe(resolvedAt);
    expect(row.closed_at).toBeNull();

    time.advance(60);
    const closedAt = time.iso();
    await api.setStatus(id, "closed");
    row = await rawIncident(id);
    expect(row.resolved_at).toBe(resolvedAt);
    expect(row.closed_at).toBe(closedAt);
  });

  it("matches each timestamp to its status-history row", async () => {
    const id = await api.newIncidentIn("closed");
    const { incident, history } = await snapshot(id);
    const at = (status) => history.find((h) => h.to_status === status).changed_at;
    expect(incident.resolved_at).toBe(at("resolved"));
    expect(incident.closed_at).toBe(at("closed"));
  });

  it("clears both on reopen, and a second resolution gets a new timestamp", async () => {
    const id = await api.newIncidentIn("closed");
    const firstResolved = (await rawIncident(id)).resolved_at;

    time.advance(10);
    await api.setStatus(id, "in_progress", { note: "recurred" });
    let row = await rawIncident(id);
    expect(row.resolved_at).toBeNull();
    expect(row.closed_at).toBeNull();

    time.advance(120);
    const secondResolved = time.iso();
    await api.setStatus(id, "resolved");
    row = await rawIncident(id);
    expect(row.resolved_at).toBe(secondResolved);
    expect(row.resolved_at).not.toBe(firstResolved);
    expect(row.closed_at).toBeNull();
  });

  it("does not set resolved_at or closed_at for holds, resumes or cancellation", async () => {
    const held = await api.newIncidentIn("on_hold");
    expect(await rawIncident(held)).toMatchObject({ resolved_at: null, closed_at: null });

    time.advance();
    await api.setStatus(held, "in_progress");
    expect(await rawIncident(held)).toMatchObject({ resolved_at: null, closed_at: null });

    const cancelled = await api.newIncidentIn("cancelled");
    expect(await rawIncident(cancelled)).toMatchObject({ resolved_at: null, closed_at: null });
  });

  it("never changes created_at or due_at, whatever happens to the incident", async () => {
    const id = await api.newIncidentIn("new");
    const original = await rawIncident(id);

    for (const step of ["assign", "in_progress", "on_hold", "in_progress", "resolved", "closed", "in_progress"]) {
      await api.step(id, step);
      const row = await rawIncident(id);
      expect([step, row.created_at, row.due_at]).toEqual([step, original.created_at, original.due_at]);
    }
  });

  it("sets assigned_at on the first assignment and moves it on reassignment, but not on status changes", async () => {
    const id = await api.newIncidentIn("new");

    time.advance();
    const firstAssigned = time.iso();
    await api.assign(id);
    expect((await rawIncident(id)).assigned_at).toBe(firstAssigned);

    time.advance();
    await api.setStatus(id, "in_progress");
    expect((await rawIncident(id)).assigned_at).toBe(firstAssigned);

    time.advance(45);
    const reassigned = time.iso();
    await api.assign(id, { to: ids.agent2 });
    expect((await rawIncident(id)).assigned_at).toBe(reassigned);
  });
});

// ---------------------------------------------------------------------------
// Status history
// ---------------------------------------------------------------------------

describe("status history", () => {
  it("records who made the change and the note, and null where none was given", async () => {
    const id = await api.newIncidentIn("assigned");

    time.advance();
    await api.setStatus(id, "in_progress", { by: ids.agent2, note: "Picking this up" });
    time.advance();
    await api.setStatus(id, "on_hold");

    const { history } = await snapshot(id);
    const [, , started, held] = history;
    expect(started).toMatchObject({ to_status: "in_progress", changed_by: ids.agent2, note: "Picking this up" });
    expect(held).toMatchObject({ to_status: "on_hold", changed_by: ids.agent, note: null });
  });

  it("records a system-triggered change (no changedBy) as null", async () => {
    const id = await api.newIncidentIn("assigned");
    time.advance();
    const res = await api.setStatus(id, "in_progress", { omitBy: true });
    expect(res.status).toBe(200);

    const { history } = await snapshot(id);
    expect(history[history.length - 1].changed_by).toBeNull();
  });

  it("adds exactly one row per successful transition", async () => {
    time.advance();
    const created = await api.create();
    const id = created.body.id;
    const steps = ["assign", "in_progress", "on_hold", "in_progress", "resolved"];

    for (let i = 0; i < steps.length; i++) {
      await api.step(id, steps[i]);
      expect((await snapshot(id)).history).toHaveLength(i + 2); // +1 for the initial row
    }
  });

  it("is returned in order, with names, from the detail endpoint", async () => {
    const id = await api.newIncidentIn("resolved");
    const res = await api.get(id);
    expect(res.body.statusHistory.map((h) => h.to_status)).toEqual(["new", "assigned", "in_progress", "resolved"]);
    expect(res.body.statusHistory[1].changed_by_name).toBe("Amara Agent");
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("status endpoint validation", () => {
  let id;
  beforeAll(async () => {
    id = await api.newIncidentIn("assigned");
  });

  const invalid = [
    ["missing", undefined],
    ["empty string", ""],
    ["wrong case", "IN_PROGRESS"],
    ["leading space", " in_progress"],
    ["space instead of underscore", "in progress"],
    ["unknown value", "done"],
    ["a number", 123],
    ["null", null],
    ["an array", ["in_progress"]],
    ["an object", { status: "in_progress" }],
    ["a boolean", true],
  ];

  test.each(invalid)("rejects a status that is %s with 400", async (_label, value) => {
    const before = await snapshot(id);
    const res = await api.setStatus(id, value);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Invalid status/);
    expect(res.body.error.message).toContain("in_progress"); // lists the valid options
    expect(await snapshot(id)).toEqual(before);
  });

  it("rejects an unknown changedBy with 400 and changes nothing", async () => {
    const before = await snapshot(id);
    const res = await api.setStatus(id, "in_progress", { by: crypto.randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Unknown changedBy/);
    expect(await snapshot(id)).toEqual(before);
  });

  it("returns 404 for an unknown incident", async () => {
    const res = await api.setStatus(crypto.randomUUID(), "in_progress");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Incident not found/);
  });

  it("reports an invalid status before it reports a missing incident", async () => {
    const res = await api.setStatus(crypto.randomUUID(), "nonsense");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Assignment and the lifecycle
// ---------------------------------------------------------------------------

describe("assignment", () => {
  it("assigning a new incident moves it to 'assigned' and logs that transition", async () => {
    const id = await api.newIncidentIn("new");
    time.advance();
    const res = await api.assign(id, { reason: "self-claim" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "assigned", assignee_id: ids.agent, assigned_at: time.iso() });

    const { history, assignments } = await snapshot(id);
    expect(history[history.length - 1]).toMatchObject({
      from_status: "new",
      to_status: "assigned",
      changed_by: ids.agent,
      changed_at: time.iso(),
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      assigned_to: ids.agent,
      assigned_by: ids.agent,
      reason: "self-claim",
      unassigned_at: null,
    });
  });

  test.each(["assigned", "in_progress", "on_hold"])(
    "reassigning a %s incident keeps its status and adds no history row",
    async (status) => {
      const id = await api.newIncidentIn(status);
      const before = await snapshot(id);

      time.advance();
      const res = await api.assign(id, { to: ids.agent2, reason: "handoff" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(status);
      expect(res.body.assignee_id).toBe(ids.agent2);

      const after = await snapshot(id);
      expect(after.history).toEqual(before.history); // an assignment change is not a status change
      expect(after.assignments).toHaveLength(2);
    }
  );

  it("closes the previous assignment and leaves exactly one open", async () => {
    const id = await api.newIncidentIn("in_progress");
    time.advance(15);
    const handoffAt = time.iso();
    await api.assign(id, { to: ids.agent2 });

    const { assignments } = await snapshot(id);
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({ assigned_to: ids.agent, unassigned_at: handoffAt });
    expect(assignments[1]).toMatchObject({ assigned_to: ids.agent2, unassigned_at: null });
  });

  test.each(["closed", "cancelled"])("refuses to assign a %s incident with 409 and changes nothing", async (status) => {
    const id = await api.newIncidentIn(status);
    const before = await snapshot(id);

    time.advance();
    const res = await api.assign(id, { to: ids.agent2 });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(`"${status}"`);
    expect(await snapshot(id)).toEqual(before);
  });

  it("agrees with the spec about which statuses can be assigned", async () => {
    for (const status of SPEC_STATUSES) {
      const id = await api.newIncidentIn(status);
      time.advance();
      const res = await api.assign(id, { to: ids.agent2 });
      expect([status, res.status === 200]).toEqual([status, assignAllowed(status)]);
    }
  });

  it("records a system assignment (no assignedBy) as null", async () => {
    const id = await api.newIncidentIn("new");
    time.advance();
    const res = await api.assign(id, { omitBy: true });
    expect(res.status).toBe(200);

    const { history, assignments } = await snapshot(id);
    expect(assignments[0].assigned_by).toBeNull();
    expect(history[history.length - 1].changed_by).toBeNull();
  });

  it("rejects a missing assignee with 400", async () => {
    const id = await api.newIncidentIn("new");
    const res = await api.assign(id, { to: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/assignedTo is required/);
  });

  it("rejects an unknown assignee or assigner with 400", async () => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);

    const badAssignee = await api.assign(id, { to: crypto.randomUUID() });
    expect(badAssignee.status).toBe(400);
    expect(badAssignee.body.error.message).toMatch(/Unknown assignedTo/);

    const badAssigner = await api.assign(id, { by: crypto.randomUUID() });
    expect(badAssigner.status).toBe(400);
    expect(badAssigner.body.error.message).toMatch(/Unknown assignedBy/);

    expect(await snapshot(id)).toEqual(before);
  });

  it("returns 404 for an unknown incident", async () => {
    const res = await api.assign(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});

describe("the status endpoint cannot be used to assign", () => {
  it("refuses new -> assigned: it would leave an 'assigned' incident with nobody assigned", async () => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);

    time.advance();
    const res = await api.setStatus(id, "assigned");

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/without an assignee/);
    expect(res.body.error.message).toMatch(/assignment/);
    expect(await snapshot(id)).toEqual(before);
  });

  it("cannot reach in_progress or resolved without having been assigned", async () => {
    const id = await api.newIncidentIn("new");
    for (const target of ["in_progress", "on_hold", "resolved", "closed"]) {
      time.advance();
      expect([target, (await api.setStatus(id, target)).status]).toEqual([target, 409]);
    }
    const row = await rawIncident(id);
    expect(row.status).toBe("new");
    expect(row.assignee_id).toBeNull();
  });

  it("every status that needs an assignee has one, after any valid journey", async () => {
    for (const status of SPEC_STATUSES.filter((s) => s !== "new" && s !== "cancelled")) {
      const id = await api.newIncidentIn(status);
      const { incident, assignments } = await snapshot(id);
      expect([status, incident.assignee_id]).toEqual([status, ids.agent]);
      expect(assignments).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Atomicity: a transition is all-or-nothing
// ---------------------------------------------------------------------------

describe("atomicity", () => {
  // Takes a table offline for the duration of `fn`, so a write to it fails.
  async function withTableOffline(table, fn) {
    await db.query(`ALTER TABLE ${table} RENAME TO ${table}_offline`);
    try {
      return await fn();
    } finally {
      await db.query(`ALTER TABLE ${table}_offline RENAME TO ${table}`);
    }
  }

  let consoleError;
  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("rolls back a status change if writing its history row fails", async () => {
    const id = await api.newIncidentIn("assigned");
    const before = await snapshot(id);

    const res = await withTableOffline("incident_status_history", async () => {
      time.advance();
      return api.setStatus(id, "in_progress");
    });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Internal server error"); // no internals leaked
    expect(consoleError).toHaveBeenCalled();

    // The UPDATE ran before the failing INSERT, so this only passes if it was rolled back.
    expect(await snapshot(id)).toEqual(before);
  });

  it("rolls back an assignment (assignment rows and the incident) if the history write fails", async () => {
    const id = await api.newIncidentIn("new");
    const before = await snapshot(id);

    const res = await withTableOffline("incident_status_history", async () => {
      time.advance();
      return api.assign(id);
    });

    expect(res.status).toBe(500);
    const after = await snapshot(id);
    expect(after.incident).toEqual(before.incident);
    expect(after.incident.status).toBe("new");
    expect(after.incident.assignee_id).toBeNull();
    expect(after.assignments).toHaveLength(0);
  });

  it("keeps working normally after a failed transition", async () => {
    const id = await api.newIncidentIn("assigned");

    await withTableOffline("incident_status_history", async () => {
      time.advance();
      await api.setStatus(id, "in_progress");
    });

    time.advance();
    const res = await api.setStatus(id, "in_progress");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Repeated and simultaneous requests
// ---------------------------------------------------------------------------

describe("double submits", () => {
  it("a repeated resolve is rejected and does not change anything", async () => {
    const id = await api.newIncidentIn("in_progress");

    time.advance();
    const first = await api.setStatus(id, "resolved");
    const afterFirst = await snapshot(id);

    time.advance(5);
    const second = await api.setStatus(id, "resolved");

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await snapshot(id)).toEqual(afterFirst);
  });

  it("two simultaneous resolves: exactly one wins, one history row is written", async () => {
    const id = await api.newIncidentIn("in_progress");
    const before = await snapshot(id);

    time.advance();
    const results = await Promise.all([api.setStatus(id, "resolved"), api.setStatus(id, "resolved")]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await snapshot(id);
    expect(after.history).toHaveLength(before.history.length + 1);
    expect(after.incident.resolved_at).toBe(time.iso());
  });

  it("two simultaneous assignments to different people leave exactly one open assignment", async () => {
    const id = await api.newIncidentIn("new");

    time.advance();
    await Promise.all([api.assign(id, { to: ids.agent }), api.assign(id, { to: ids.agent2 })]);

    const { incident, assignments } = await snapshot(id);
    const open = assignments.filter((a) => a.unassigned_at === null);
    expect(open).toHaveLength(1);
    expect(open[0].assigned_to).toBe(incident.assignee_id);
  });

  test.todo(
    "simultaneous transitions on Postgres need a row lock (SELECT ... FOR UPDATE); cannot be verified without a Postgres instance"
  );
});

// ---------------------------------------------------------------------------
// The lifecycle and the SLA
// ---------------------------------------------------------------------------

describe("lifecycle drives the SLA", () => {
  const sla = async (id) => (await api.get(id)).body.sla.resolution;

  it("time spent on hold does not count: resolved 29h after creation, but 6h of it on hold, meets a 24h target", async () => {
    time.advance();
    const created = await api.create(); // P3, 24h target
    const id = created.body.id;

    time.advance(60); // +1h
    await api.assign(id);
    time.advance(60); // +2h
    await api.setStatus(id, "in_progress");
    time.advance(120); // +4h
    await api.setStatus(id, "on_hold");
    time.advance(6 * 60); // +10h  (6h on hold)
    await api.setStatus(id, "in_progress");
    time.advance(19 * 60); // +29h
    await api.setStatus(id, "resolved");

    const r = await sla(id);
    expect(r.status).toBe("met");
    expect(r.breached).toBe(false);
    expect(r.paused_ms).toBe(6 * HOUR);
    expect(Date.parse(r.due_at) - Date.parse(r.original_due_at)).toBe(6 * HOUR);
  });

  it("without the hold the same timeline is a breach", async () => {
    time.advance();
    const created = await api.create();
    const id = created.body.id;
    for (const step of ["assign", "in_progress"]) await api.step(id, step);
    time.advance(26 * 60);
    await api.setStatus(id, "resolved");

    const r = await sla(id);
    expect(r.status).toBe("breached"); // resolved late
    expect(r.breached).toBe(true);
    expect(r.paused_ms).toBe(0);
  });

  it("an incident currently on hold reads as paused", async () => {
    const id = await api.newIncidentIn("on_hold");
    const r = await sla(id);
    expect(r.status).toBe("paused");
    expect(r.paused).toBe(true);
    expect(r.breached).toBe(false);
  });

  it("reopening a resolved incident stops it counting as met", async () => {
    const id = await api.newIncidentIn("resolved");
    expect((await sla(id)).status).toBe("met");

    time.advance();
    await api.setStatus(id, "in_progress");
    const r = await sla(id);
    expect(r.status).not.toBe("met");
    expect((await rawIncident(id)).resolved_at).toBeNull();
  });

  it("a cancelled incident has no SLA to breach", async () => {
    const id = await api.newIncidentIn("cancelled");
    expect((await sla(id)).status).toBe("not_applicable");
  });
});

describe("escalation and the lifecycle", () => {
  it("raising an incident's priority does not change its status, history or timestamps", async () => {
    const id = await api.newIncidentIn("in_progress");
    const before = await snapshot(id);

    // 20 hours after creation: past 75% of P3's 24h target.
    const result = await runEscalationCycle({ now: new Date(Date.parse(before.incident.created_at) + 20 * HOUR) });
    expect(result.escalated.map((e) => e.incident_id)).toContain(id);

    const after = await snapshot(id);
    expect(after.incident.priority_id).toBe(ids.priorities[2]);
    expect({ ...after.incident, priority_id: null }).toEqual({ ...before.incident, priority_id: null });
    expect(after.history).toEqual(before.history);
    expect(after.assignments).toEqual(before.assignments);
  });

  it("does not escalate an incident once it has been resolved", async () => {
    const id = await api.newIncidentIn("resolved");
    const created = (await rawIncident(id)).created_at;

    const result = await runEscalationCycle({ now: new Date(Date.parse(created) + 100 * HOUR) });

    expect(result.escalated.map((e) => e.incident_id)).not.toContain(id);
    expect((await rawIncident(id)).priority_id).toBe(ids.priority);
  });
});

// ---------------------------------------------------------------------------
// Decisions not made yet. Listed so they stay visible rather than being
// pinned (or forgotten) by accident.
// ---------------------------------------------------------------------------

describe("open design questions", () => {
  test.todo("reopening a closed incident should only be allowed within a set window (Week 1 design: 'within N days of closing')");
  test.todo("decide whether a resolved incident may be reassigned (currently allowed)");
  test.todo("decide whether the SLA clock should pause between resolution and a reopen");
});
