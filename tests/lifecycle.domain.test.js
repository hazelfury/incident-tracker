const fs = require("fs");
const path = require("path");
const L = require("../src/domain/incidentLifecycle");
const { ESCALATABLE_STATUSES, decideEscalation } = require("../src/domain/escalationPolicy");
const { evaluateSla } = require("../src/domain/slaCalculator");
const dashboard = require("../public/js/dashboard-utils");
const { SPEC_STATUSES, SPEC_TRANSITIONS, SPEC_ACTIVE, SPEC_FINISHED } = require("./helpers/lifecycleSpec");

// ---------------------------------------------------------------------------
// The transition table
// ---------------------------------------------------------------------------

describe("transition table", () => {
  it("lists exactly the seven lifecycle statuses, in order", () => {
    expect([...L.STATUSES]).toEqual(SPEC_STATUSES);
  });

  it("matches the documented transitions exactly", () => {
    expect(JSON.parse(JSON.stringify(L.TRANSITIONS))).toEqual(SPEC_TRANSITIONS);
  });

  it("has an entry for every status and no extras", () => {
    expect(Object.keys(L.TRANSITIONS).sort()).toEqual([...SPEC_STATUSES].sort());
  });

  it("only ever points at real statuses", () => {
    for (const [from, targets] of Object.entries(L.TRANSITIONS)) {
      for (const to of targets) {
        expect([from, to, SPEC_STATUSES.includes(to)]).toEqual([from, to, true]);
      }
    }
  });

  it("never allows a status to move to itself", () => {
    for (const status of L.STATUSES) {
      expect(L.TRANSITIONS[status]).not.toContain(status);
    }
  });

  it("lists no target twice from the same status", () => {
    for (const targets of Object.values(L.TRANSITIONS)) {
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it("has exactly one terminal status: cancelled", () => {
    const terminal = L.STATUSES.filter((s) => L.TRANSITIONS[s].length === 0);
    expect(terminal).toEqual(["cancelled"]);
  });

  it("has exactly one entry point: nothing can move back to 'new'", () => {
    const incoming = L.STATUSES.filter((s) => L.TRANSITIONS[s].includes("new"));
    expect(incoming).toEqual([]);
  });

  it("can reach every status from 'new'", () => {
    const seen = new Set(["new"]);
    const queue = ["new"];
    while (queue.length) {
      for (const next of L.TRANSITIONS[queue.shift()]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...SPEC_STATUSES].sort());
  });

  it("has no dead ends: every non-terminal status can still reach a finished status", () => {
    const canFinish = (start) => {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        if (SPEC_FINISHED.includes(current)) return true;
        for (const next of L.TRANSITIONS[current]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };
    for (const status of L.STATUSES.filter((s) => s !== "cancelled")) {
      expect([status, canFinish(status)]).toEqual([status, true]);
    }
  });

  it("is frozen, so no code can change the rules at runtime", () => {
    expect(Object.isFrozen(L.STATUSES)).toBe(true);
    expect(Object.isFrozen(L.TRANSITIONS)).toBe(true);
    for (const targets of Object.values(L.TRANSITIONS)) {
      expect(Object.isFrozen(targets)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// canTransition / allowedNext: every one of the 49 pairs
// ---------------------------------------------------------------------------

describe("canTransition", () => {
  const allPairs = SPEC_STATUSES.flatMap((from) =>
    SPEC_STATUSES.map((to) => [from, to, SPEC_TRANSITIONS[from].includes(to)])
  );

  test.each(allPairs)("%s -> %s: allowed = %s", (from, to, expected) => {
    expect(L.canTransition(from, to)).toBe(expected);
  });

  it("is false for unknown statuses on either side", () => {
    expect(L.canTransition("bogus", "new")).toBe(false);
    expect(L.canTransition("new", "bogus")).toBe(false);
    expect(L.canTransition(undefined, undefined)).toBe(false);
    expect(L.canTransition(null, "assigned")).toBe(false);
  });

  it("is case sensitive", () => {
    expect(L.canTransition("NEW", "assigned")).toBe(false);
    expect(L.canTransition("new", "Assigned")).toBe(false);
  });
});

describe("allowedNext", () => {
  test.each(SPEC_STATUSES)("%s returns its documented targets", (status) => {
    expect(L.allowedNext(status)).toEqual(SPEC_TRANSITIONS[status]);
  });

  it("returns [] for unknown statuses, including names inherited from Object", () => {
    ["bogus", "", undefined, null, "constructor", "__proto__", "toString", "hasOwnProperty"].forEach((value) => {
      expect([value, L.allowedNext(value)]).toEqual([value, []]);
    });
  });

  it("returns a copy: changing it cannot corrupt the rules", () => {
    const first = L.allowedNext("new");
    first.push("resolved");
    expect(L.allowedNext("new")).toEqual(["assigned", "cancelled"]);
    expect(L.canTransition("new", "resolved")).toBe(false);
  });
});

describe("isValidStatus", () => {
  test.each(SPEC_STATUSES)("accepts %s", (status) => {
    expect(L.isValidStatus(status)).toBe(true);
  });

  test.each([
    ["empty string", ""],
    ["upper case", "NEW"],
    ["leading space", " new"],
    ["trailing space", "new "],
    ["space instead of underscore", "in progress"],
    ["hyphen instead of underscore", "in-progress"],
    ["null", null],
    ["undefined", undefined],
    ["number", 1],
    ["object", {}],
    ["array containing a valid status", ["new"]],
    ["inherited property name", "constructor"],
  ])("rejects %s", (_label, value) => {
    expect(L.isValidStatus(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What each status means
// ---------------------------------------------------------------------------

describe("status semantics", () => {
  //            status         active  finished assignable afterAssign   assigneeRequired
  const table = [
    ["new", true, false, true, "assigned", false],
    ["assigned", true, false, true, "assigned", true],
    ["in_progress", true, false, true, "in_progress", true],
    ["on_hold", true, false, true, "on_hold", true],
    ["resolved", false, true, true, "resolved", true],
    ["closed", false, true, false, "closed", true],
    ["cancelled", false, false, false, "cancelled", false],
  ];

  test.each(table)("%s", (status, active, finished, assignable, afterAssign, assigneeRequired) => {
    expect(L.isActive(status)).toBe(active);
    expect(L.isFinished(status)).toBe(finished);
    expect(L.canAssign(status)).toBe(assignable);
    expect(L.statusAfterAssignment(status)).toBe(afterAssign);
    expect(L.ASSIGNEE_REQUIRED_STATUSES.includes(status)).toBe(assigneeRequired);
  });

  it("covers every status, so a new status can't be added without deciding what it means", () => {
    expect(table.map((row) => row[0])).toEqual(SPEC_STATUSES);
  });

  it("agrees with the spec on which statuses are active and which are finished", () => {
    expect(L.STATUSES.filter(L.isActive)).toEqual(SPEC_ACTIVE);
    expect(L.STATUSES.filter(L.isFinished)).toEqual(SPEC_FINISHED);
  });

  it("treats unknown statuses as not active", () => {
    expect(L.isActive("bogus")).toBe(false);
    expect(L.isActive(undefined)).toBe(false);
  });

  it("every finished status is inactive, and cancelled is inactive but not finished", () => {
    SPEC_FINISHED.forEach((s) => expect(L.INACTIVE_STATUSES).toContain(s));
    expect(L.INACTIVE_STATUSES).toContain("cancelled");
    expect(L.isFinished("cancelled")).toBe(false);
  });
});

describe("isReopen", () => {
  test.each([
    ["resolved", "in_progress", true],
    ["closed", "in_progress", true],
    ["on_hold", "in_progress", false], // resuming from hold is not a reopen
    ["assigned", "in_progress", false],
    ["resolved", "closed", false],
    ["in_progress", "resolved", false],
    ["resolved", "resolved", false],
  ])("%s -> %s: reopen = %s", (from, to, expected) => {
    expect(L.isReopen(from, to)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// resolved_at / closed_at
// ---------------------------------------------------------------------------

describe("timestampsForTransition", () => {
  const NOW = "2026-03-02T10:00:00.000Z";
  const RESOLVED = "2026-03-02T08:00:00.000Z";
  const CLOSED = "2026-03-02T09:00:00.000Z";
  const run = (from, to, current = {}) => L.timestampsForTransition({ from, to, now: NOW, ...current });

  it("stamps resolved_at when resolving and leaves closed_at alone", () => {
    expect(run("in_progress", "resolved")).toEqual({ resolved_at: NOW, closed_at: null });
  });

  it("stamps closed_at when closing and KEEPS the existing resolved_at", () => {
    expect(run("resolved", "closed", { resolved_at: RESOLVED })).toEqual({ resolved_at: RESOLVED, closed_at: NOW });
  });

  it("clears both when reopening from resolved", () => {
    expect(run("resolved", "in_progress", { resolved_at: RESOLVED })).toEqual({ resolved_at: null, closed_at: null });
  });

  it("clears both when reopening from closed", () => {
    expect(run("closed", "in_progress", { resolved_at: RESOLVED, closed_at: CLOSED })).toEqual({
      resolved_at: null,
      closed_at: null,
    });
  });

  it("does not touch either timestamp for transitions that aren't resolve/close/reopen", () => {
    expect(run("in_progress", "on_hold")).toEqual({ resolved_at: null, closed_at: null });
    expect(run("on_hold", "in_progress")).toEqual({ resolved_at: null, closed_at: null });
    expect(run("assigned", "in_progress")).toEqual({ resolved_at: null, closed_at: null });
    expect(run("new", "cancelled")).toEqual({ resolved_at: null, closed_at: null });
  });

  it("re-resolving after a reopen takes a fresh timestamp", () => {
    const later = "2026-03-03T10:00:00.000Z";
    expect(L.timestampsForTransition({ from: "in_progress", to: "resolved", now: later, resolved_at: null })).toEqual({
      resolved_at: later,
      closed_at: null,
    });
  });

  it("treats missing current values as null rather than undefined", () => {
    const result = L.timestampsForTransition({ from: "in_progress", to: "on_hold", now: NOW });
    expect(result.resolved_at).toBeNull();
    expect(result.closed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Every part of the system that has a view on statuses agrees with the rules
// ---------------------------------------------------------------------------

describe("agreement across the codebase", () => {
  it("the database CHECK constraint allows exactly these statuses, and defaults to the entry status", () => {
    const schema = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
    const match = schema.match(/status\s+TEXT NOT NULL DEFAULT '(\w+)'\s+CHECK \(status IN \(([^)]*)\)\)/);
    expect(match).not.toBeNull();

    expect(match[1]).toBe("new");
    const allowed = match[2].split(",").map((v) => v.trim().replace(/'/g, ""));
    expect([...allowed].sort()).toEqual([...L.STATUSES].sort());
  });

  it("the dashboard knows every status, in the same order, with a label for each", () => {
    expect(dashboard.STATUS_ORDER).toEqual([...L.STATUSES]);
    expect(Object.keys(dashboard.STATUS_LABELS).sort()).toEqual([...L.STATUSES].sort());
    L.STATUSES.forEach((s) => expect(dashboard.statusLabel(s)).not.toBe(s));
  });

  test.each(SPEC_STATUSES)("the dashboard and the lifecycle agree whether %s is active", (status) => {
    expect(dashboard.isActive({ status })).toBe(L.isActive(status));
  });

  it("escalation applies to active statuses except on_hold", () => {
    const expected = L.STATUSES.filter((s) => L.isActive(s) && s !== "on_hold");
    expect([...ESCALATABLE_STATUSES].sort()).toEqual([...expected].sort());
  });

  describe("escalation decisions per status", () => {
    const P3 = { id: "p3", name: "P3 - Medium", level: 3, sla_resolution_mins: 1440 };
    const P2 = { id: "p2", name: "P2 - High", level: 2, sla_resolution_mins: 480 };
    const now = new Date("2026-03-10T00:00:00.000Z");
    const old = "2026-03-02T00:00:00.000Z"; // 8 days: far past any threshold

    test.each(SPEC_STATUSES)("%s", (status) => {
      const d = decideEscalation({
        incident: { status, created_at: old },
        currentPriority: P3,
        nextPriority: P2,
        now,
      });
      if (status === "on_hold") expect(d).toMatchObject({ escalate: false, skip: "on_hold" });
      else if (SPEC_ACTIVE.includes(status)) expect(d.escalate).toBe(true);
      else expect(d).toMatchObject({ escalate: false, skip: "not_active" });
    });
  });

  describe("SLA evaluation per status", () => {
    const created = "2026-03-02T00:00:00.000Z";
    const due = "2026-03-03T00:00:00.000Z"; // 24h target
    const now = new Date("2026-03-02T12:00:00.000Z"); // 12h in: 50% used

    test.each(SPEC_STATUSES)("%s", (status) => {
      const incident = {
        status,
        created_at: created,
        due_at: due,
        resolved_at: SPEC_FINISHED.includes(status) ? "2026-03-02T10:00:00.000Z" : null,
      };
      const r = evaluateSla({ incident, now }).resolution;

      if (status === "cancelled") expect(r.status).toBe("not_applicable");
      else if (SPEC_FINISHED.includes(status)) expect(r.status).toBe("met");
      else if (status === "on_hold") expect(r.status).toBe("paused");
      else expect(r.status).toBe("on_track");
    });
  });
});
