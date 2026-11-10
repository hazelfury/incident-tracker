// Random walks through the lifecycle.
//
// Hand-written cases cover the journeys someone thought of. This test takes
// many seeded random journeys, mixing legal and illegal moves, and after EVERY
// step checks a list of invariants that must hold no matter how the incident
// got there. It uses the service layer directly (faster than HTTP) and an
// oracle (tests/helpers/lifecycleSpec.js) that is independent of the code.
//
// Seeds are fixed, so a failure is reproducible: the error message includes
// the seed and the full list of actions taken.

const { installClock, bootstrap, rawIncident, rawHistory, rawAssignments, db } = require("./helpers/lifecycleHarness");
const {
  SPEC_STATUSES,
  SPEC_TRANSITIONS,
  SPEC_FINISHED,
  statusEndpointAllows,
  assignAllowed,
} = require("./helpers/lifecycleSpec");
const incidentService = require("../src/services/incidentService");

let ctx, ids, time;

beforeAll(async () => {
  time = installClock();
  ctx = await bootstrap();
  ids = ctx.ids;
});

afterAll(async () => {
  time.restore();
  await db.close();
});

// Small deterministic PRNG (mulberry32), so each seed always plays the same game.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSIGNEE_REQUIRED = ["assigned", "in_progress", "on_hold", "resolved", "closed"];

// Which (from -> to) attempts and which "assign while in <status>" attempts the walks have exercised.
const exercised = { status: new Set(), assign: new Set() };

async function attempt(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    if (typeof err.statusCode === "number") return { ok: false, statusCode: err.statusCode };
    throw err; // anything else is a real crash, not a rejected request
  }
}

async function runWalk(seed, stepCount) {
  const rand = makeRng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const trace = [`seed ${seed}`];
  const fail = (message) => {
    throw new Error(`${message}\n  actions so far: ${trace.join(" | ")}`);
  };
  const check = (condition, message) => {
    if (!condition) fail(message);
  };

  time.advance();
  const created = await incidentService.createIncident({
    title: `walk ${seed}`,
    reporterId: ids.reporter,
    categoryId: ids.category,
    priorityId: ids.priority,
  });
  const initial = await rawIncident(created.id);
  let expectedHistoryLength = 1;

  const assertInvariants = async (label) => {
    const incident = await rawIncident(created.id);
    const history = await rawHistory(created.id);
    const assignments = await rawAssignments(created.id);
    const where = `after ${label}`;

    check(SPEC_STATUSES.includes(incident.status), `${where}: status "${incident.status}" is not a real status`);

    // History is a gap-free chain that ends at the current status.
    check(history.length === expectedHistoryLength, `${where}: expected ${expectedHistoryLength} history rows, found ${history.length}`);
    check(history[0].from_status === null && history[0].to_status === "new", `${where}: first history row should be null -> new`);
    for (let i = 1; i < history.length; i++) {
      check(history[i].from_status === history[i - 1].to_status, `${where}: history row ${i} starts at "${history[i].from_status}" but the previous ended at "${history[i - 1].to_status}"`);
      check(history[i].changed_at > history[i - 1].changed_at, `${where}: history row ${i} is not later than row ${i - 1}`);
    }
    check(history[history.length - 1].to_status === incident.status, `${where}: last history row says "${history[history.length - 1].to_status}" but status is "${incident.status}"`);

    // Every transition in the chain is one the rules allow.
    for (let i = 1; i < history.length; i++) {
      check(SPEC_TRANSITIONS[history[i].from_status].includes(history[i].to_status), `${where}: history contains the illegal move ${history[i].from_status} -> ${history[i].to_status}`);
    }

    // Resolution timestamps exist exactly when they should, and match the history.
    const isFinished = SPEC_FINISHED.includes(incident.status);
    check((incident.resolved_at !== null) === isFinished, `${where}: resolved_at is ${incident.resolved_at} while status is "${incident.status}"`);
    check((incident.closed_at !== null) === (incident.status === "closed"), `${where}: closed_at is ${incident.closed_at} while status is "${incident.status}"`);
    if (incident.resolved_at !== null) {
      const lastResolved = [...history].reverse().find((h) => h.to_status === "resolved");
      check(lastResolved && lastResolved.changed_at === incident.resolved_at, `${where}: resolved_at does not match the latest "resolved" history row`);
    }
    if (incident.closed_at !== null) {
      const lastClosed = [...history].reverse().find((h) => h.to_status === "closed");
      check(lastClosed && lastClosed.changed_at === incident.closed_at, `${where}: closed_at does not match the latest "closed" history row`);
      check(incident.closed_at >= incident.resolved_at, `${where}: closed before it was resolved`);
    }

    // Anything past "new" has been assigned to someone, and the records agree.
    if (ASSIGNEE_REQUIRED.includes(incident.status)) {
      check(incident.assignee_id !== null, `${where}: status "${incident.status}" but nobody is assigned`);
    }
    const open = assignments.filter((a) => a.unassigned_at === null);
    if (incident.assignee_id === null) {
      check(assignments.length === 0, `${where}: no assignee but ${assignments.length} assignment rows exist`);
    } else {
      check(open.length === 1, `${where}: expected exactly one open assignment, found ${open.length}`);
      check(open[0].assigned_to === incident.assignee_id, `${where}: open assignment is for a different person than assignee_id`);
      check(incident.assigned_at === assignments[assignments.length - 1].assigned_at, `${where}: assigned_at does not match the latest assignment`);
    }

    // These never change.
    check(incident.created_at === initial.created_at, `${where}: created_at changed`);
    check(incident.due_at === initial.due_at, `${where}: due_at changed`);
  };

  await assertInvariants("creation");

  for (let step = 1; step <= stepCount; step++) {
    time.advance();
    const from = (await rawIncident(created.id)).status;
    const roll = rand();

    // A mix, so the walk both gets places and probes the rules' boundaries:
    //   ~18% assign someone, ~47% a legal status move, ~35% a move the rules forbid.
    let action;
    if (roll < 0.18) {
      action = { type: "assign" };
    } else if (roll < 0.65 && SPEC_TRANSITIONS[from].length) {
      // "cancelled" is a dead end, so it is chosen rarely; otherwise most walks
      // would end early and never reach resolved, closed or a reopen.
      const options = SPEC_TRANSITIONS[from];
      const onward = options.filter((s) => s !== "cancelled");
      const to = onward.length && rand() > 0.1 ? pick(onward) : pick(options);
      // The only way into "assigned" is by assigning someone.
      action = to === "assigned" ? { type: "assign" } : { type: "status", to };
    } else {
      const forbidden = SPEC_STATUSES.filter((to) => !statusEndpointAllows(from, to));
      action = { type: "status", to: pick(forbidden) };
    }

    if (action.type === "assign") {
      const assignee = pick([ids.agent, ids.agent2]);
      const expectOk = assignAllowed(from);
      trace.push(`assign(${assignee === ids.agent ? "agent" : "agent2"}) while ${from}`);

      const result = await attempt(() =>
        incidentService.assignIncident({ incidentId: created.id, assignedTo: assignee, assignedBy: assignee })
      );
      exercised.assign.add(`${from}:${expectOk ? "ok" : "rejected"}`);

      check(result.ok === expectOk, `step ${step}: assigning a "${from}" incident ${result.ok ? "succeeded" : `was rejected (${result.statusCode})`}, expected ${expectOk ? "success" : "rejection"}`);
      if (!result.ok) check(result.statusCode === 409, `step ${step}: rejected with ${result.statusCode}, expected 409`);
      if (result.ok && from === "new") expectedHistoryLength += 1;
    } else {
      const expectOk = statusEndpointAllows(from, action.to);
      trace.push(`${from} -> ${action.to}`);

      const result = await attempt(() =>
        incidentService.updateStatus({ incidentId: created.id, toStatus: action.to, changedBy: ids.agent })
      );
      exercised.status.add(`${from}->${action.to}:${expectOk ? "ok" : "rejected"}`);

      check(result.ok === expectOk, `step ${step}: ${from} -> ${action.to} ${result.ok ? "succeeded" : `was rejected (${result.statusCode})`}, expected ${expectOk ? "success" : "rejection"}`);
      if (!result.ok) check(result.statusCode === 409, `step ${step}: rejected with ${result.statusCode}, expected 409`);
      if (result.ok) expectedHistoryLength += 1;
    }

    await assertInvariants(`step ${step} (${trace[trace.length - 1]})`);
  }
}

describe("random walks keep every invariant", () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

  test.each(seeds)("seed %i", async (seed) => {
    await runWalk(seed, 16);
  });
});

describe("the walks were thorough", () => {
  it("tried every one of the 49 status moves, and each was accepted or rejected as the rules say", () => {
    const missing = [];
    for (const from of SPEC_STATUSES) {
      for (const to of SPEC_STATUSES) {
        const outcome = statusEndpointAllows(from, to) ? "ok" : "rejected";
        if (!exercised.status.has(`${from}->${to}:${outcome}`)) missing.push(`${from} -> ${to} (${outcome})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("tried assigning an incident in every one of the 7 statuses", () => {
    const missing = SPEC_STATUSES.filter(
      (status) => !exercised.assign.has(`${status}:${assignAllowed(status) ? "ok" : "rejected"}`)
    );
    expect(missing).toEqual([]);
  });
});
