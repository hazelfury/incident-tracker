const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const request = require("supertest");
const createApp = require("../src/app");
const db = require("../src/config/database");
const { runEscalationCycle } = require("../src/services/escalationService");
const { startEscalationJob } = require("../src/jobs/escalationJob");
const { findNextHigherPriority, formatMinutes, decideEscalation } = require("../src/domain/escalationPolicy");

const HOUR = 3600000;
const MIN = 60000;

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

const P1 = { id: "p1", name: "P1 - Critical", level: 1, sla_resolution_mins: 240 };
const P2 = { id: "p2", name: "P2 - High", level: 2, sla_resolution_mins: 480 };
const P3 = { id: "p3", name: "P3 - Medium", level: 3, sla_resolution_mins: 1440 };
const P4 = { id: "p4", name: "P4 - Low", level: 4, sla_resolution_mins: 4320 };
const LADDER = [P1, P2, P3, P4];

const NOW = new Date("2026-10-14T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();

describe("findNextHigherPriority", () => {
  it("returns the next more urgent level", () => {
    expect(findNextHigherPriority(LADDER, P4)).toBe(P3);
    expect(findNextHigherPriority(LADDER, P3)).toBe(P2);
    expect(findNextHigherPriority(LADDER, P2)).toBe(P1);
  });

  it("returns null at the top", () => {
    expect(findNextHigherPriority(LADDER, P1)).toBeNull();
  });

  it("copes with gaps and unsorted input", () => {
    const sparse = [
      { level: 5, id: "a" },
      { level: 1, id: "b" },
      { level: 3, id: "c" },
    ];
    expect(findNextHigherPriority(sparse, { level: 5 }).id).toBe("c");
    expect(findNextHigherPriority(sparse, { level: 3 }).id).toBe("b");
  });
});

describe("formatMinutes", () => {
  it("formats compactly", () => {
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(125)).toBe("2h 5m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(1620)).toBe("1d 3h");
    expect(formatMinutes(1440)).toBe("1d");
  });
});

describe("decideEscalation", () => {
  // P3 target is 24h, so at 75% the threshold is 18h.
  const decide = (overrides = {}) =>
    decideEscalation({
      incident: { status: "new", created_at: hoursAgo(20) },
      currentPriority: P3,
      nextPriority: P2,
      now: NOW,
      ...overrides,
    });

  it("escalates once the age passes the threshold", () => {
    const d = decide();
    expect(d.escalate).toBe(true);
    expect(d.reason).toMatch(/P3 - Medium/);
    expect(d.reason).toMatch(/P2 - High/);
  });

  it("does not escalate below the threshold", () => {
    const d = decide({ incident: { status: "new", created_at: hoursAgo(17.9) } });
    expect(d.escalate).toBe(false);
    expect(d.skip).toBe("below_threshold");
  });

  it("escalates at exactly the threshold", () => {
    expect(decide({ incident: { status: "new", created_at: hoursAgo(18) } }).escalate).toBe(true);
  });

  it("respects a custom threshold percentage", () => {
    const inc = { status: "new", created_at: hoursAgo(13) };
    expect(decide({ incident: inc, thresholdPercent: 50 }).escalate).toBe(true); // 12h threshold
    expect(decide({ incident: inc, thresholdPercent: 75 }).escalate).toBe(false);
  });

  it("applies to new, assigned and in_progress incidents", () => {
    ["new", "assigned", "in_progress"].forEach((status) => {
      expect(decide({ incident: { status, created_at: hoursAgo(20) } }).escalate).toBe(true);
    });
  });

  it("never escalates finished or cancelled incidents", () => {
    ["resolved", "closed", "cancelled"].forEach((status) => {
      const d = decide({ incident: { status, created_at: hoursAgo(500) } });
      expect(d.escalate).toBe(false);
      expect(d.skip).toBe("not_active");
    });
  });

  it("never escalates an incident that is on hold right now", () => {
    const d = decide({ incident: { status: "on_hold", created_at: hoursAgo(500) } });
    expect(d.escalate).toBe(false);
    expect(d.skip).toBe("on_hold");
  });

  it("does not escalate past the top priority", () => {
    const d = decide({ currentPriority: P1, nextPriority: null });
    expect(d.escalate).toBe(false);
    expect(d.skip).toBe("highest_priority");
  });

  it("excludes time spent on hold from the age", () => {
    // 30h old, but on hold for 18 of them: 12h active, below the 18h threshold.
    const history = [
      { to_status: "on_hold", changed_at: hoursAgo(28) },
      { to_status: "in_progress", changed_at: hoursAgo(10) },
    ];
    const d = decide({ incident: { status: "in_progress", created_at: hoursAgo(30) }, history });
    expect(d.escalate).toBe(false);
    expect(Math.round(d.active_ms / HOUR)).toBe(12);
  });

  it("measures from the last escalation, not from creation (no cascading)", () => {
    // 100h old, but only raised to this priority 1h ago.
    const d = decide({
      incident: { status: "new", created_at: hoursAgo(100) },
      lastEscalationAt: hoursAgo(1),
    });
    expect(d.escalate).toBe(false);
    expect(Math.round(d.active_ms / HOUR)).toBe(1);
  });

  it("ignores hold time from before the last escalation", () => {
    const history = [
      { to_status: "on_hold", changed_at: hoursAgo(90) },
      { to_status: "in_progress", changed_at: hoursAgo(60) },
    ];
    // Escalated 20h ago: the whole 20h since then is active time.
    const d = decide({
      incident: { status: "in_progress", created_at: hoursAgo(100) },
      history,
      lastEscalationAt: hoursAgo(20),
    });
    expect(d.escalate).toBe(true);
    expect(Math.round(d.active_ms / HOUR)).toBe(20);
  });

  it("skips incidents with unusable dates instead of throwing", () => {
    const d = decide({ incident: { status: "new", created_at: "garbage" } });
    expect(d.escalate).toBe(false);
    expect(d.skip).toBe("invalid_dates");
  });
});

// ---------------------------------------------------------------------------
// Escalation cycle against a real (in-memory) database
// ---------------------------------------------------------------------------

const schemaSql = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
const app = createApp();

let reporter, agent, category;
const pid = {}; // priority ids by level

const iso = (ms) => new Date(ms).toISOString();

/**
 * Inserts an incident directly with exact timestamps (no API, no timing
 * races). `holds` is a list of { startHoursAgo, endHoursAgo } (omit
 * endHoursAgo for a hold that is still open; set status to "on_hold" to match).
 */
async function insertIncident({ title, level, status = "new", ageHours, holds = [], assignedHoursAgo = null }) {
  const id = crypto.randomUUID();
  const base = Date.now();
  const created = base - ageHours * HOUR;
  const sla = { 1: 240, 2: 480, 3: 1440, 4: 4320 }[level];

  await db.query(
    `INSERT INTO incidents (id, title, status, reporter_id, category_id, priority_id, created_at, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, status, reporter, category, pid[level], iso(created), iso(created + sla * MIN)]
  );
  await db.query(
    "INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, NULL, 'new', ?, ?)",
    [crypto.randomUUID(), id, reporter, iso(created)]
  );
  for (const h of holds) {
    await db.query(
      "INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, 'in_progress', 'on_hold', ?, ?)",
      [crypto.randomUUID(), id, agent, iso(base - h.startHoursAgo * HOUR)]
    );
    if (h.endHoursAgo !== undefined) {
      await db.query(
        "INSERT INTO incident_status_history (id, incident_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, 'on_hold', 'in_progress', ?, ?)",
        [crypto.randomUUID(), id, agent, iso(base - h.endHoursAgo * HOUR)]
      );
    }
  }
  if (assignedHoursAgo !== null) {
    await db.query(
      "INSERT INTO incident_assignments (id, incident_id, assigned_to, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?)",
      [crypto.randomUUID(), id, agent, agent, iso(base - assignedHoursAgo * HOUR)]
    );
  }
  return id;
}

const priorityLevelOf = async (id) =>
  (await db.query("SELECT p.level FROM incidents i JOIN priorities p ON p.id = i.priority_id WHERE i.id = ?", [id]))
    .rows[0].level;

const escalationRows = async (id) =>
  (await db.query("SELECT * FROM incident_escalations WHERE incident_id = ? ORDER BY escalated_at", [id])).rows;

beforeAll(async () => {
  db.init();
  await db.runScript(schemaSql);

  reporter = crypto.randomUUID();
  agent = crypto.randomUUID();
  category = crypto.randomUUID();
  await db.query("INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)", [
    reporter,
    "Riley Requester",
    "riley@example.com",
    "h",
    "requester",
  ]);
  await db.query("INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)", [
    agent,
    "Amara Agent",
    "amara@example.com",
    "h",
    "agent",
  ]);
  await db.query("INSERT INTO categories (id, name) VALUES (?, ?)", [category, "Network"]);

  const defs = [
    [1, "P1 - Critical", 15, 240],
    [2, "P2 - High", 30, 480],
    [3, "P3 - Medium", 120, 1440],
    [4, "P4 - Low", 480, 4320],
  ];
  for (const [level, name, resp, resol] of defs) {
    pid[level] = crypto.randomUUID();
    await db.query(
      "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
      [pid[level], name, level, resp, resol]
    );
  }
});

afterAll(async () => {
  await db.close();
});

describe("runEscalationCycle", () => {
  it("dry run reports what would escalate and changes nothing", async () => {
    const id = await insertIncident({ title: "Dry run subject", level: 3, ageHours: 20 });

    const result = await runEscalationCycle({ dryRun: true });

    expect(result.dry_run).toBe(true);
    const entry = result.escalated.find((e) => e.incident_id === id);
    expect(entry).toMatchObject({ from_priority: "P3 - Medium", to_priority: "P2 - High" });
    expect(await priorityLevelOf(id)).toBe(3);
    expect(await escalationRows(id)).toHaveLength(0);
  });

  it("raises an over-age incident one level and writes an audit row", async () => {
    const id = await insertIncident({ title: "Escalate me", level: 3, ageHours: 20 });
    const before = (await db.query("SELECT due_at FROM incidents WHERE id = ?", [id])).rows[0].due_at;

    const result = await runEscalationCycle();

    expect(result.escalated.map((e) => e.incident_id)).toContain(id);
    expect(await priorityLevelOf(id)).toBe(2);

    const rows = await escalationRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_priority_id: pid[3], to_priority_id: pid[2], escalated_by: null });
    expect(rows[0].reason).toMatch(/Open 20h at P3 - Medium/);

    // Escalation never moves the original deadline.
    const after = (await db.query("SELECT due_at FROM incidents WHERE id = ?", [id])).rows[0].due_at;
    expect(after).toBe(before);
  });

  it("does not escalate an incident under the threshold", async () => {
    const id = await insertIncident({ title: "Young incident", level: 3, ageHours: 5 });
    await runEscalationCycle();
    expect(await priorityLevelOf(id)).toBe(3);
  });

  it("is idempotent: running again straight away does not escalate again", async () => {
    const id = await insertIncident({ title: "Only once", level: 4, ageHours: 70 }); // threshold 54h
    await runEscalationCycle();
    expect(await priorityLevelOf(id)).toBe(3);

    const second = await runEscalationCycle();
    expect(second.escalated.map((e) => e.incident_id)).not.toContain(id);
    expect(await priorityLevelOf(id)).toBe(3);
    expect(await escalationRows(id)).toHaveLength(1);
  });

  it("climbs one level at a time as time passes, then stops at the top", async () => {
    const id = await insertIncident({ title: "Climber", level: 3, ageHours: 20 });
    const t0 = Date.now();

    await runEscalationCycle({ now: new Date(t0) });
    expect(await priorityLevelOf(id)).toBe(2); // P3 -> P2 (due at 18h of age)

    await runEscalationCycle({ now: new Date(t0 + 5.9 * HOUR) });
    expect(await priorityLevelOf(id)).toBe(2); // P2 needs 6h (75% of 8h) since the last change

    await runEscalationCycle({ now: new Date(t0 + 6.1 * HOUR) });
    expect(await priorityLevelOf(id)).toBe(1); // P2 -> P1

    await runEscalationCycle({ now: new Date(t0 + 500 * HOUR) });
    expect(await priorityLevelOf(id)).toBe(1); // nowhere higher to go
    expect(await escalationRows(id)).toHaveLength(2);
  });

  it("never escalates an incident that is on hold", async () => {
    const id = await insertIncident({
      title: "On hold forever",
      level: 3,
      status: "on_hold",
      ageHours: 300,
      holds: [{ startHoursAgo: 290 }],
    });
    await runEscalationCycle();
    expect(await priorityLevelOf(id)).toBe(3);
  });

  it("excludes past hold time from the age", async () => {
    // 30h old but on hold for 18h of it: 12h of active time, below 18h.
    const id = await insertIncident({
      title: "Mostly waiting",
      level: 3,
      status: "in_progress",
      ageHours: 30,
      holds: [{ startHoursAgo: 28, endHoursAgo: 10 }],
    });
    await runEscalationCycle();
    expect(await priorityLevelOf(id)).toBe(3);
  });

  it("leaves finished, cancelled and top-priority incidents alone", async () => {
    const resolved = await insertIncident({ title: "Already resolved", level: 3, status: "resolved", ageHours: 200 });
    const cancelled = await insertIncident({ title: "Cancelled one", level: 3, status: "cancelled", ageHours: 200 });
    const critical = await insertIncident({ title: "Already critical", level: 1, ageHours: 200 });

    await runEscalationCycle();

    expect(await priorityLevelOf(resolved)).toBe(3);
    expect(await priorityLevelOf(cancelled)).toBe(3);
    expect(await priorityLevelOf(critical)).toBe(1);
  });
});

describe("API", () => {
  it("POST /api/escalations/run?dryRun=true returns the report without changing data", async () => {
    const id = await insertIncident({ title: "API dry run", level: 4, ageHours: 60 });

    const res = await request(app).post("/api/escalations/run?dryRun=true");

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.escalated.map((e) => e.incident_id)).toContain(id);
    expect(await priorityLevelOf(id)).toBe(4);
  });

  it("POST /api/escalations/run performs the escalation", async () => {
    const id = await insertIncident({ title: "API real run", level: 4, ageHours: 60 });

    const res = await request(app).post("/api/escalations/run");

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(false);
    expect(await priorityLevelOf(id)).toBe(3);
  });

  it("GET /api/incidents/:id includes SLA and the escalation history with names", async () => {
    const id = await insertIncident({ title: "Detail subject", level: 3, ageHours: 20 });
    await runEscalationCycle();

    const res = await request(app).get(`/api/incidents/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.priority_name).toBe("P2 - High");
    expect(res.body.escalation_count).toBe(1);
    expect(res.body.original_priority_name).toBe("P3 - Medium");
    expect(res.body.escalations).toHaveLength(1);
    expect(res.body.escalations[0]).toMatchObject({
      from_priority_name: "P3 - Medium",
      to_priority_name: "P2 - High",
      escalated_by_name: null,
    });
    expect(res.body.sla.resolution.status).toBe("at_risk"); // 20h of a 24h window
    expect(res.body.sla.resolution.breached).toBe(false);
  });

  it("an escalation does not turn the SLA into a breach against the new priority's shorter target", async () => {
    // 20h old at P3 (24h target). After escalation to P2 (8h target) it must
    // still be judged against its original deadline.
    const id = await insertIncident({ title: "Not retroactively breached", level: 3, ageHours: 20 });
    await runEscalationCycle();

    const res = await request(app).get(`/api/incidents/${id}`);
    expect(res.body.priority_name).toBe("P2 - High");
    expect(res.body.sla.resolution.breached).toBe(false);
  });

  it("GET /api/incidents includes sla and escalation fields on every row", async () => {
    const res = await request(app).get("/api/incidents");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    res.body.forEach((row) => {
      expect(row.sla).toBeTruthy();
      expect(row.sla.resolution).toBeTruthy();
      expect(typeof row.escalation_count).toBe("number");
    });
  });

  it("reports a paused SLA for an incident on hold within its target", async () => {
    const id = await insertIncident({
      title: "Paused within target",
      level: 3,
      status: "on_hold",
      ageHours: 14,
      holds: [{ startHoursAgo: 4 }],
    });
    const res = await request(app).get(`/api/incidents/${id}`);
    expect(res.body.sla.resolution.status).toBe("paused");
    expect(res.body.sla.resolution.paused).toBe(true);
    expect(res.body.sla.resolution.breached).toBe(false);
  });

  it("reports a breached resolution and response SLA correctly", async () => {
    // P2: 30-minute response target, 8h resolution target. 12h old, never assigned.
    const id = await insertIncident({ title: "Both breached", level: 2, ageHours: 12 });
    const res = await request(app).get(`/api/incidents/${id}`);
    expect(res.body.sla.resolution.status).toBe("breached");
    expect(res.body.sla.response.status).toBe("breached");
    expect(res.body.sla.breached).toBe(true);
  });

  it("judges the response SLA against the priority at creation, so escalation can't flip a met response", async () => {
    // Created as P3 (120-minute response target), assigned after 90 minutes: met.
    // Escalated afterwards to P2 (30-minute target): must still read as met.
    const id = await insertIncident({ title: "Responded in time", level: 3, ageHours: 20, assignedHoursAgo: 20 - 1.5 });
    await runEscalationCycle();

    const res = await request(app).get(`/api/incidents/${id}`);
    expect(res.body.priority_name).toBe("P2 - High");
    expect(res.body.sla.response.status).toBe("met");
  });
});

// ---------------------------------------------------------------------------
// Scheduler job (no database: the cycle is injected)
// ---------------------------------------------------------------------------

const quietLogger = { log: () => {}, error: () => {} };
const emptyResult = { escalated: [], errors: [] };

describe("startEscalationJob", () => {
  it("runs once immediately on start", async () => {
    const runCycle = jest.fn().mockResolvedValue(emptyResult);
    const job = startEscalationJob({ intervalMs: 1e9, runCycle, logger: quietLogger });
    await job.stop();
    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the previous run is still going", async () => {
    let release;
    const runCycle = jest.fn(() => new Promise((resolve) => (release = () => resolve(emptyResult))));
    const job = startEscalationJob({ intervalMs: 1e9, runCycle, logger: quietLogger });

    job.runNow();
    job.runNow();
    expect(runCycle).toHaveBeenCalledTimes(1);

    release();
    await job.stop();
  });

  it("can run again once the previous run has finished", async () => {
    const runCycle = jest.fn().mockResolvedValue(emptyResult);
    const job = startEscalationJob({ intervalMs: 1e9, runCycle, logger: quietLogger });
    // The startup run is still in flight here, so this call joins it rather
    // than starting another (that's the overlap guard); awaiting it lets it finish.
    await job.runNow();
    expect(runCycle).toHaveBeenCalledTimes(1);

    await job.runNow();
    await job.runNow();
    await job.stop();
    expect(runCycle).toHaveBeenCalledTimes(3); // startup + two sequential manual runs
  });

  it("survives a failing cycle, logs it, and keeps working", async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const runCycle = jest.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(emptyResult);
    const job = startEscalationJob({ intervalMs: 1e9, runCycle, logger });
    await job.stop();
    expect(logger.error).toHaveBeenCalledWith("[escalation] cycle failed", expect.any(Error));

    await job.runNow();
    expect(runCycle).toHaveBeenCalledTimes(2);
  });

  it("logs the incidents it escalated", async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const runCycle = jest.fn().mockResolvedValue({
      escalated: [{ title: "VPN down", from_priority: "P3 - Medium", to_priority: "P2 - High" }],
      errors: [],
    });
    const job = startEscalationJob({ intervalMs: 1e9, runCycle, logger });
    await job.stop();
    const lines = logger.log.mock.calls.map((c) => c[0]).join("\n");
    expect(lines).toMatch(/VPN down: P3 - Medium -> P2 - High/);
  });
});
