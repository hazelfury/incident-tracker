// Shared setup for the lifecycle tests: an in-memory database with the real
// schema, reference data, the Express app, a controllable clock, and small
// helpers for driving and inspecting incidents.
//
// Every test file gets its own copy of the database (Jest isolates modules per
// file), so these helpers are called from each file's beforeAll.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const request = require("supertest");
const createApp = require("../../src/app");
const db = require("../../src/config/database");
const clock = require("../../src/utils/clock");

const schemaSql = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const MINUTE = 60000;
const HOUR = 60 * MINUTE;

const PRIORITY_DEFS = [
  [1, "P1 - Critical", 15, 240],
  [2, "P2 - High", 30, 480],
  [3, "P3 - Medium", 120, 1440],
  [4, "P4 - Low", 480, 4320],
];

/**
 * Replaces the app clock with one the test controls. Call advance() before an
 * action to give it its own timestamp; iso() is that timestamp as the app
 * will have stored it.
 */
function installClock(startIso = "2026-03-02T09:00:00.000Z") {
  let current = Date.parse(startIso);
  clock.setSource(() => new Date(current));
  return {
    now: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    advance(minutes = 1) {
      current += minutes * MINUTE;
      return new Date(current);
    },
    restore: () => clock.reset(),
  };
}

async function bootstrap() {
  db.init();
  await db.runScript(schemaSql);

  const ids = {
    team: crypto.randomUUID(),
    reporter: crypto.randomUUID(),
    agent: crypto.randomUUID(),
    agent2: crypto.randomUUID(),
    category: crypto.randomUUID(),
    priorities: {},
  };

  await db.query("INSERT INTO teams (id, name) VALUES (?, ?)", [ids.team, "Support"]);
  const users = [
    [ids.reporter, "Riley Requester", "riley@example.com", "requester"],
    [ids.agent, "Amara Agent", "amara@example.com", "agent"],
    [ids.agent2, "Omar Agent", "omar@example.com", "agent"],
  ];
  for (const [id, name, email, role] of users) {
    await db.query(
      "INSERT INTO users (id, name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)",
      [id, name, email, "hash", role, ids.team]
    );
  }
  await db.query("INSERT INTO categories (id, name) VALUES (?, ?)", [ids.category, "Network"]);
  for (const [level, name, response, resolution] of PRIORITY_DEFS) {
    ids.priorities[level] = crypto.randomUUID();
    await db.query(
      "INSERT INTO priorities (id, name, level, sla_response_mins, sla_resolution_mins) VALUES (?, ?, ?, ?, ?)",
      [ids.priorities[level], name, level, response, resolution]
    );
  }
  ids.priority = ids.priorities[3]; // default: P3, 24h resolution target

  return { app: createApp(), ids };
}

// The valid way to reach each status from "new", as API steps.
const PATH_TO_STATUS = {
  new: [],
  assigned: ["assign"],
  in_progress: ["assign", "in_progress"],
  on_hold: ["assign", "in_progress", "on_hold"],
  resolved: ["assign", "in_progress", "resolved"],
  closed: ["assign", "in_progress", "resolved", "closed"],
  cancelled: ["cancelled"],
};

function makeApi({ app, ids }, time) {
  const api = {
    create: (overrides = {}) =>
      request(app)
        .post("/api/incidents")
        .send({
          title: "Lifecycle test incident",
          reporterId: ids.reporter,
          categoryId: ids.category,
          priorityId: ids.priority,
          ...overrides,
        }),

    // Options default to a valid request. Passing a key explicitly, even as
    // undefined, overrides the default, so a test can send a request with a
    // field missing ({ to: undefined }) rather than silently getting the default.
    assign: (id, opts = {}) => {
      const to = "to" in opts ? opts.to : ids.agent;
      const by = "by" in opts ? opts.by : ids.agent;
      const body = { assignedTo: to, reason: opts.reason };
      if (!opts.omitBy) body.assignedBy = by;
      return request(app).patch(`/api/incidents/${id}/assignment`).send(body);
    },

    setStatus: (id, status, opts = {}) => {
      const by = "by" in opts ? opts.by : ids.agent;
      const body = { status, note: opts.note };
      if (!opts.omitBy) body.changedBy = by;
      return request(app).patch(`/api/incidents/${id}/status`).send(body);
    },

    get: (id) => request(app).get(`/api/incidents/${id}`),

    // One step of a path: "assign" or a status name. Advances the clock first.
    step: async (id, step) => {
      time.advance();
      return step === "assign" ? api.assign(id) : api.setStatus(id, step);
    },

    // A fresh incident, driven through valid steps until it is in `status`.
    newIncidentIn: async (status, overrides = {}) => {
      time.advance();
      const created = await api.create(overrides);
      if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
      for (const step of PATH_TO_STATUS[status]) {
        const res = await api.step(created.body.id, step);
        if (res.status !== 200) {
          throw new Error(`could not drive to "${status}" at step "${step}": ${res.status} ${JSON.stringify(res.body)}`);
        }
      }
      return created.body.id;
    },
  };
  return api;
}

// Direct database reads, so assertions don't depend on the API under test.
const rawIncident = async (id) => (await db.query("SELECT * FROM incidents WHERE id = ?", [id])).rows[0];
const rawHistory = async (id) =>
  (await db.query("SELECT * FROM incident_status_history WHERE incident_id = ? ORDER BY changed_at", [id])).rows;
const rawAssignments = async (id) =>
  (await db.query("SELECT * FROM incident_assignments WHERE incident_id = ? ORDER BY assigned_at", [id])).rows;

async function snapshot(id) {
  return {
    incident: await rawIncident(id),
    history: await rawHistory(id),
    assignments: await rawAssignments(id),
  };
}

module.exports = {
  MINUTE,
  HOUR,
  PATH_TO_STATUS,
  installClock,
  bootstrap,
  makeApi,
  rawIncident,
  rawHistory,
  rawAssignments,
  snapshot,
  db,
};
