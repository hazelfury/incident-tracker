const U = require("../public/js/dashboard-utils");

const NOW = new Date("2026-10-14T12:00:00.000Z");
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600000).toISOString();

function incident(overrides = {}) {
  return {
    id: "i1",
    title: "Something broke",
    status: "new",
    priority_id: "p-high",
    priority_name: "P2 - High",
    priority_level: 2,
    assignee_id: null,
    assignee_name: null,
    category_name: "Network",
    reporter_name: "Riley Requester",
    created_at: hoursFromNow(-2),
    due_at: hoursFromNow(5),
    resolved_at: null,
    ...overrides,
  };
}

describe("priorityClass", () => {
  it("maps levels 1-4 to their colour class", () => {
    expect(U.priorityClass(1)).toBe("prio-1");
    expect(U.priorityClass(2)).toBe("prio-2");
    expect(U.priorityClass(3)).toBe("prio-3");
    expect(U.priorityClass(4)).toBe("prio-4");
  });

  it("accepts numeric strings", () => {
    expect(U.priorityClass("1")).toBe("prio-1");
  });

  it("falls back to a neutral class for unknown or missing levels", () => {
    expect(U.priorityClass(0)).toBe("prio-other");
    expect(U.priorityClass(7)).toBe("prio-other");
    expect(U.priorityClass(null)).toBe("prio-other");
    expect(U.priorityClass(undefined)).toBe("prio-other");
  });
});

describe("statusLabel", () => {
  it("returns readable labels", () => {
    expect(U.statusLabel("in_progress")).toBe("In progress");
    expect(U.statusLabel("on_hold")).toBe("On hold");
  });

  it("does not throw on unknown or missing statuses", () => {
    expect(U.statusLabel("weird")).toBe("weird");
    expect(U.statusLabel(undefined)).toBe("Unknown");
  });
});

describe("parseDate", () => {
  it("parses ISO strings", () => {
    expect(U.parseDate("2026-10-14T12:00:00.000Z").getTime()).toBe(NOW.getTime());
  });

  it("treats SQLite's zone-less CURRENT_TIMESTAMP format as UTC", () => {
    expect(U.parseDate("2026-10-14 12:00:00").getTime()).toBe(NOW.getTime());
  });

  it("returns null for empty or invalid input", () => {
    expect(U.parseDate(null)).toBeNull();
    expect(U.parseDate("")).toBeNull();
    expect(U.parseDate("not a date")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats minutes, hours and days compactly", () => {
    expect(U.formatDuration(30 * 1000)).toBe("<1m");
    expect(U.formatDuration(47 * 60000)).toBe("47m");
    expect(U.formatDuration(60 * 60000)).toBe("1h");
    expect(U.formatDuration((2 * 60 + 59) * 60000)).toBe("2h 59m");
    expect(U.formatDuration(24 * 60 * 60000)).toBe("1d");
    expect(U.formatDuration(26 * 60 * 60000)).toBe("1d 2h");
  });

  it("ignores sign, so it works for overdue durations", () => {
    expect(U.formatDuration(-18 * 3600000)).toBe("18h");
  });
});

describe("isOverdue and dueInfo", () => {
  it("flags an active incident past its due time", () => {
    const i = incident({ status: "in_progress", due_at: hoursFromNow(-2) });
    expect(U.isOverdue(i, NOW)).toBe(true);
    expect(U.dueInfo(i, NOW)).toEqual({ text: "Overdue by 2h", tone: "overdue" });
  });

  it("shows time remaining, and 'soon' when under an hour", () => {
    expect(U.dueInfo(incident({ due_at: hoursFromNow(5) }), NOW)).toEqual({ text: "Due in 5h", tone: "ok" });
    expect(U.dueInfo(incident({ due_at: hoursFromNow(0.5) }), NOW)).toEqual({ text: "Due in 30m", tone: "soon" });
  });

  it("never marks resolved, closed or cancelled incidents as overdue", () => {
    ["resolved", "closed", "cancelled"].forEach((status) => {
      expect(U.isOverdue(incident({ status, due_at: hoursFromNow(-10) }), NOW)).toBe(false);
    });
  });

  it("reports whether a resolved incident met its SLA", () => {
    const onTime = incident({ status: "resolved", due_at: hoursFromNow(-1), resolved_at: hoursFromNow(-3) });
    const late = incident({ status: "resolved", due_at: hoursFromNow(-3), resolved_at: hoursFromNow(-1) });
    expect(U.dueInfo(onTime, NOW).text).toBe("Resolved on time");
    expect(U.dueInfo(late, NOW).text).toBe("Resolved late");
  });

  it("shows a dash for cancelled incidents or missing due dates", () => {
    expect(U.dueInfo(incident({ status: "cancelled" }), NOW).text).toBe("—");
    expect(U.dueInfo(incident({ due_at: null }), NOW).text).toBe("—");
  });
});

describe("filterIncidents", () => {
  const list = [
    incident({ id: "a", title: "VPN down", status: "new", priority_id: "p1", assignee_name: null }),
    incident({
      id: "b",
      title: "Printer jam",
      status: "assigned",
      priority_id: "p2",
      assignee_name: "Amara Agent",
      category_name: "Hardware",
    }),
    incident({ id: "c", title: "Email outage", status: "assigned", priority_id: "p1", assignee_name: "Omar Agent" }),
  ];
  const ids = (arr) => arr.map((i) => i.id);

  it("returns everything by default", () => {
    expect(ids(U.filterIncidents(list))).toEqual(["a", "b", "c"]);
  });

  it("filters by status", () => {
    expect(ids(U.filterIncidents(list, { status: "assigned" }))).toEqual(["b", "c"]);
    expect(ids(U.filterIncidents(list, { status: "closed" }))).toEqual([]);
  });

  it("filters by priority", () => {
    expect(ids(U.filterIncidents(list, { priorityId: "p1" }))).toEqual(["a", "c"]);
  });

  it("searches title, assignee and category case-insensitively", () => {
    expect(ids(U.filterIncidents(list, { search: "vpn" }))).toEqual(["a"]);
    expect(ids(U.filterIncidents(list, { search: "AMARA" }))).toEqual(["b"]);
    expect(ids(U.filterIncidents(list, { search: "hardware" }))).toEqual(["b"]);
  });

  it("combines filters", () => {
    expect(ids(U.filterIncidents(list, { status: "assigned", priorityId: "p1" }))).toEqual(["c"]);
  });
});

describe("sortIncidents", () => {
  it("puts active incidents first, then orders by priority, then soonest due", () => {
    const list = [
      incident({ id: "resolved-p1", status: "resolved", priority_level: 1 }),
      incident({ id: "p3", priority_level: 3, due_at: hoursFromNow(2) }),
      incident({ id: "p1-later", priority_level: 1, due_at: hoursFromNow(8) }),
      incident({ id: "p1-sooner", priority_level: 1, due_at: hoursFromNow(1) }),
      incident({ id: "p2", priority_level: 2, due_at: hoursFromNow(4) }),
    ];
    expect(U.sortIncidents(list).map((i) => i.id)).toEqual(["p1-sooner", "p1-later", "p2", "p3", "resolved-p1"]);
  });

  it("does not mutate the input array", () => {
    const list = [incident({ id: "x", priority_level: 3 }), incident({ id: "y", priority_level: 1 })];
    U.sortIncidents(list);
    expect(list.map((i) => i.id)).toEqual(["x", "y"]);
  });
});

describe("countByStatus and summarize", () => {
  const list = [
    incident({ id: "1", status: "new", priority_level: 1, due_at: hoursFromNow(-1) }),
    incident({ id: "2", status: "in_progress", priority_level: 1, assignee_id: "u1", due_at: hoursFromNow(3) }),
    incident({ id: "3", status: "assigned", priority_level: 3, assignee_id: "u1", due_at: hoursFromNow(-5) }),
    incident({ id: "4", status: "resolved", priority_level: 1, assignee_id: "u1", due_at: hoursFromNow(-9) }),
    incident({ id: "5", status: "cancelled", priority_level: 2 }),
  ];

  it("counts incidents per status, including zeros", () => {
    expect(U.countByStatus(list)).toEqual({
      all: 5,
      new: 1,
      assigned: 1,
      in_progress: 1,
      on_hold: 0,
      resolved: 1,
      closed: 0,
      cancelled: 1,
    });
  });

  it("summarises open, critical, overdue and unassigned counts", () => {
    expect(U.summarize(list, NOW)).toEqual({
      open: 3, // new, in_progress, assigned
      criticalOpen: 2, // P1 and still active (#1, #2); the resolved P1 doesn't count
      overdue: 2, // #1 and #3; the resolved one is excluded
      unassigned: 1, // only #1 (cancelled #5 is not active)
    });
  });
});

// ---------------------------------------------------------------------------
// Server-evaluated SLA (Week 6): the helpers prefer incident.sla when present
// ---------------------------------------------------------------------------

function withSla(overrides = {}, resolution = {}, response = {}) {
  return incident({
    status: "in_progress",
    sla: {
      resolution: {
        status: "on_track",
        breached: false,
        paused: false,
        due_at: hoursFromNow(5),
        remaining_ms: 5 * 3600000,
        paused_ms: 0,
        ...resolution,
      },
      response: {
        status: "met",
        breached: false,
        due_at: hoursFromNow(-1),
        responded_at: hoursFromNow(-1.5),
        ...response,
      },
    },
    ...overrides,
  });
}

describe("dueInfo with a server SLA", () => {
  it("shows time remaining, using the effective due date from the server", () => {
    expect(U.dueInfo(withSla(), NOW)).toEqual({ text: "Due in 5h", tone: "ok" });
  });

  it("flags at_risk as a warning tone even with plenty of time left", () => {
    expect(U.dueInfo(withSla({}, { status: "at_risk" }), NOW).tone).toBe("soon");
  });

  it("shows a breach with how long ago the deadline passed", () => {
    const i = withSla({}, { status: "breached", breached: true, due_at: hoursFromNow(-3) });
    expect(U.dueInfo(i, NOW)).toEqual({ text: "Breached by 3h", tone: "overdue" });
  });

  it("shows a paused clock for an incident on hold", () => {
    const i = withSla({ status: "on_hold" }, { status: "paused", paused: true });
    expect(U.dueInfo(i, NOW)).toEqual({ text: "Paused (on hold)", tone: "paused" });
  });

  it("shows an incident that breached before going on hold as still breached", () => {
    const i = withSla({ status: "on_hold" }, { status: "breached", breached: true, paused: true });
    expect(U.dueInfo(i, NOW)).toEqual({ text: "Breached · on hold", tone: "overdue" });
  });

  it("reports finished incidents as on time or late", () => {
    expect(U.dueInfo(withSla({ status: "resolved" }, { status: "met" }), NOW).text).toBe("Resolved on time");
    expect(U.dueInfo(withSla({ status: "closed" }, { status: "breached", breached: true }), NOW).text).toBe(
      "Resolved late"
    );
  });

  it("shows a dash when the server says SLA does not apply", () => {
    expect(U.dueInfo(withSla({ status: "cancelled" }, { status: "not_applicable" }), NOW).text).toBe("—");
  });

  it("falls back to due_at-only logic when there is no server SLA", () => {
    const i = incident({ status: "in_progress", due_at: hoursFromNow(-2) });
    expect(U.dueInfo(i, NOW).text).toBe("Overdue by 2h");
  });
});

describe("isOverdue and summarize with a server SLA", () => {
  it("trusts the server's breached flag", () => {
    expect(U.isOverdue(withSla({}, { status: "breached", breached: true }), NOW)).toBe(true);
    expect(U.isOverdue(withSla(), NOW)).toBe(false);
  });

  it("does not call a paused (on hold) incident overdue just because due_at has passed", () => {
    // The raw due_at is in the past, but the server pushed the effective due date out.
    const i = withSla(
      { status: "on_hold", due_at: hoursFromNow(-3) },
      { status: "paused", paused: true, due_at: hoursFromNow(2) }
    );
    expect(U.isOverdue(i, NOW)).toBe(false);
  });

  it("notices a deadline that passed since the last refresh", () => {
    const i = withSla({}, { status: "at_risk", due_at: hoursFromNow(-0.1) });
    expect(U.isOverdue(i, NOW)).toBe(true);
  });

  it("never marks finished incidents overdue", () => {
    expect(U.isOverdue(withSla({ status: "resolved" }, { status: "breached", breached: true }), NOW)).toBe(false);
  });

  it("counts breaches from the server evaluation in the summary", () => {
    const list = [
      withSla({ id: "a" }, { status: "breached", breached: true }),
      withSla(
        { id: "b", status: "on_hold", due_at: hoursFromNow(-3) },
        { status: "paused", paused: true, due_at: hoursFromNow(2) }
      ),
      withSla({ id: "c" }),
    ];
    expect(U.summarize(list, NOW).overdue).toBe(1);
  });
});

describe("responseInfo", () => {
  it("describes met, late, missed and pending responses", () => {
    expect(U.responseInfo(withSla({}, {}, { status: "met" }), NOW)).toEqual({
      text: "Responded on time",
      tone: "done",
    });
    expect(
      U.responseInfo(withSla({}, {}, { status: "breached", breached: true, responded_at: hoursFromNow(-1) }), NOW).text
    ).toBe("Responded late");
    expect(U.responseInfo(withSla({}, {}, { status: "breached", breached: true, responded_at: null }), NOW).text).toBe(
      "No response yet, target missed"
    );
    expect(
      U.responseInfo(withSla({}, {}, { status: "pending", responded_at: null, due_at: hoursFromNow(0.5) }), NOW).text
    ).toBe("Respond within 30m");
  });

  it("shows a dash when there is no SLA data or it does not apply", () => {
    expect(U.responseInfo(incident(), NOW).text).toBe("—");
    expect(U.responseInfo(withSla({}, {}, { status: "not_applicable" }), NOW).text).toBe("—");
  });
});
