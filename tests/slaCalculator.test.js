const { toMs, holdPeriods, overlapMs, evaluateSla } = require("../src/domain/slaCalculator");

const HOUR = 3600000;
const T0 = Date.parse("2026-10-14T00:00:00.000Z"); // incident creation
const at = (hours) => new Date(T0 + hours * HOUR); // T0 + N hours

// A P3-style incident: 24h resolution target, created at T0.
function incident(overrides = {}) {
  return {
    status: "in_progress",
    created_at: at(0).toISOString(),
    due_at: at(24).toISOString(),
    resolved_at: null,
    ...overrides,
  };
}

const hist = (toStatus, hours) => ({ to_status: toStatus, changed_at: at(hours).toISOString() });

describe("toMs", () => {
  it("parses Dates, ISO strings, epoch numbers and SQLite's zone-less format", () => {
    expect(toMs(at(1))).toBe(T0 + HOUR);
    expect(toMs(at(1).toISOString())).toBe(T0 + HOUR);
    expect(toMs(T0)).toBe(T0);
    expect(toMs("2026-10-14 00:00:00")).toBe(T0);
  });

  it("returns null for empty or unparseable values", () => {
    expect(toMs(null)).toBeNull();
    expect(toMs(undefined)).toBeNull();
    expect(toMs("")).toBeNull();
    expect(toMs("garbage")).toBeNull();
    expect(toMs(new Date("nope"))).toBeNull();
  });
});

describe("holdPeriods", () => {
  it("pairs each on_hold row with the next transition", () => {
    const history = [hist("new", 0), hist("on_hold", 2), hist("in_progress", 5), hist("on_hold", 8), hist("in_progress", 9)];
    expect(holdPeriods(history, at(20).getTime(), "in_progress")).toEqual([
      [T0 + 2 * HOUR, T0 + 5 * HOUR],
      [T0 + 8 * HOUR, T0 + 9 * HOUR],
    ]);
  });

  it("treats a trailing hold as still open only if the incident is on hold now", () => {
    const history = [hist("on_hold", 2)];
    expect(holdPeriods(history, at(10).getTime(), "on_hold")).toEqual([[T0 + 2 * HOUR, T0 + 10 * HOUR]]);
    // Not on hold now: zero length, so a mis-ordered history can't freeze a clock.
    expect(holdPeriods(history, at(10).getTime(), "in_progress")).toEqual([[T0 + 2 * HOUR, T0 + 2 * HOUR]]);
  });

  it("sorts unordered history and ignores rows with unusable dates", () => {
    const history = [hist("in_progress", 5), { to_status: "on_hold", changed_at: "garbage" }, hist("on_hold", 2)];
    expect(holdPeriods(history, at(10).getTime(), "in_progress")).toEqual([[T0 + 2 * HOUR, T0 + 5 * HOUR]]);
  });

  it("returns nothing when there was never a hold", () => {
    expect(holdPeriods([hist("new", 0), hist("assigned", 1)], at(5).getTime(), "assigned")).toEqual([]);
  });

  it("throws when now is missing", () => {
    expect(() => evaluateSla({ incident: { status: "new", created_at: "2026-03-02T09:00:00Z", due_at: "2026-03-02T17:00:00Z" } })).toThrow(TypeError);
  });
});

describe("overlapMs", () => {
  const periods = [[T0 + 2 * HOUR, T0 + 5 * HOUR]];

  it("counts only the part of a period inside the window", () => {
    expect(overlapMs(periods, T0, T0 + 24 * HOUR)).toBe(3 * HOUR);
    expect(overlapMs(periods, T0 + 4 * HOUR, T0 + 24 * HOUR)).toBe(1 * HOUR);
    expect(overlapMs(periods, T0, T0 + 3 * HOUR)).toBe(1 * HOUR);
  });

  it("is zero when the window misses the period entirely", () => {
    expect(overlapMs(periods, T0 + 6 * HOUR, T0 + 9 * HOUR)).toBe(0);
  });
});

describe("resolution SLA", () => {
  const evalAt = (hours, inc = incident(), extra = {}) =>
    evaluateSla({ incident: inc, now: at(hours), ...extra }).resolution;

  it("is on_track early in the window", () => {
    const r = evalAt(6);
    expect(r.status).toBe("on_track");
    expect(r.breached).toBe(false);
    expect(r.percent_elapsed).toBe(25);
    expect(r.remaining_ms).toBe(18 * HOUR);
  });

  it("becomes at_risk at the configured percentage (default 80%)", () => {
    expect(evalAt(19).status).toBe("on_track"); // 79.2%
    expect(evalAt(19.2).status).toBe("at_risk"); // exactly 80%
    expect(evalAt(23).status).toBe("at_risk");
    expect(evalAt(19.2, incident(), { atRiskPercent: 90 }).status).toBe("on_track");
  });

  it("is not breached exactly at the deadline, and is breached after it", () => {
    expect(evalAt(24).breached).toBe(false);
    const late = evalAt(26);
    expect(late.status).toBe("breached");
    expect(late.breached).toBe(true);
    expect(late.remaining_ms).toBe(-2 * HOUR);
  });

  it("is not applicable for cancelled incidents", () => {
    const r = evalAt(100, incident({ status: "cancelled" }));
    expect(r.status).toBe("not_applicable");
    expect(r.breached).toBe(false);
  });

  it("is not applicable when the incident has no due date", () => {
    expect(evalAt(5, incident({ due_at: null })).status).toBe("not_applicable");
  });

  describe("finished incidents", () => {
    it("is met when resolved before the deadline, however long ago", () => {
      const inc = incident({ status: "resolved", resolved_at: at(20).toISOString() });
      const r = evalAt(500, inc);
      expect(r.status).toBe("met");
      expect(r.breached).toBe(false);
    });

    it("is breached (resolved late) when resolved after the deadline", () => {
      const inc = incident({ status: "closed", resolved_at: at(30).toISOString() });
      const r = evalAt(500, inc);
      expect(r.status).toBe("breached");
      expect(r.breached).toBe(true);
    });

    it("treats resolving exactly at the deadline as met", () => {
      expect(evalAt(500, incident({ status: "resolved", resolved_at: at(24).toISOString() })).status).toBe("met");
    });
  });

  describe("on-hold time pauses the clock", () => {
    it("excludes completed holds from elapsed time and pushes the due date out", () => {
      // 30h wall-clock, but 10h of it on hold: 20h of SLA time used.
      const history = [hist("on_hold", 4), hist("in_progress", 14)];
      const r = evalAt(30, incident(), { history });
      expect(r.paused_ms).toBe(10 * HOUR);
      expect(r.status).toBe("at_risk"); // 20/24 = 83%
      expect(r.breached).toBe(false);
      expect(r.due_at).toBe(at(34).toISOString()); // original 24h + 10h of hold
      expect(r.original_due_at).toBe(at(24).toISOString());
    });

    it("the same incident WITHOUT the hold would be breached", () => {
      expect(evalAt(30).breached).toBe(true);
    });

    it("reports paused while currently on hold, and the clock stops moving", () => {
      const inc = incident({ status: "on_hold" });
      const history = [hist("on_hold", 10)];
      const early = evalAt(12, inc, { history });
      const later = evalAt(200, inc, { history });
      expect(early.status).toBe("paused");
      expect(early.paused).toBe(true);
      expect(later.status).toBe("paused"); // 190h on hold, still not breached
      expect(later.breached).toBe(false);
      expect(later.percent_elapsed).toBe(early.percent_elapsed); // 10/24, unchanged
    });

    it("an incident already past its deadline stays breached while on hold", () => {
      const inc = incident({ status: "on_hold" });
      const history = [hist("on_hold", 30)]; // went on hold after breaching at 24h
      const r = evalAt(40, inc, { history });
      expect(r.status).toBe("breached");
      expect(r.paused).toBe(true);
    });

    it("handles several separate holds", () => {
      const history = [hist("on_hold", 2), hist("in_progress", 4), hist("on_hold", 10), hist("in_progress", 15)];
      const r = evalAt(40, incident(), { history });
      expect(r.paused_ms).toBe(7 * HOUR);
      expect(r.due_at).toBe(at(31).toISOString());
      expect(r.breached).toBe(true); // 33h of active time vs 24h
    });

    it("only counts hold time up to the resolution moment for resolved incidents", () => {
      const inc = incident({ status: "resolved", resolved_at: at(22).toISOString() });
      const history = [hist("on_hold", 5), hist("in_progress", 9)];
      const r = evalAt(100, inc, { history });
      expect(r.paused_ms).toBe(4 * HOUR);
      expect(r.status).toBe("met");
    });
  });
});

describe("response SLA", () => {
  // Response target 30 minutes.
  const respond = (hoursNow, firstResponseAt, inc = incident({ status: "new" })) =>
    evaluateSla({ incident: inc, responseTargetMins: 30, firstResponseAt, now: at(hoursNow) }).response;

  it("is pending before the target passes with no response", () => {
    const r = respond(0.25, null);
    expect(r.status).toBe("pending");
    expect(r.breached).toBe(false);
    expect(r.due_at).toBe(at(0.5).toISOString());
  });

  it("is breached once the target passes with no response", () => {
    expect(respond(1, null).status).toBe("breached");
  });

  it("is met when first assigned within the target, regardless of how much later we look", () => {
    const r = respond(100, at(0.4));
    expect(r.status).toBe("met");
    expect(r.responded_at).toBe(at(0.4).toISOString());
  });

  it("is met when assigned exactly at the target", () => {
    expect(respond(100, at(0.5)).status).toBe("met");
  });

  it("is breached when first assigned after the target", () => {
    const r = respond(100, at(2));
    expect(r.status).toBe("breached");
    expect(r.breached).toBe(true);
  });

  it("is not applicable for cancelled incidents or when no target is known", () => {
    expect(respond(5, null, incident({ status: "cancelled" })).status).toBe("not_applicable");
    expect(evaluateSla({ incident: incident(), now: at(5) }).response.status).toBe("not_applicable");
  });
});

describe("overall breached flag", () => {
  it("is true if either SLA is breached, false if neither is", () => {
    const base = { incident: incident({ status: "assigned" }), responseTargetMins: 30, firstResponseAt: at(0.2) };
    expect(evaluateSla({ ...base, now: at(5) }).breached).toBe(false);
    expect(evaluateSla({ ...base, now: at(30) }).breached).toBe(true); // resolution breached
    expect(evaluateSla({ ...base, firstResponseAt: at(3), now: at(5) }).breached).toBe(true); // response breached
  });

  it("reports when it was evaluated", () => {
    expect(evaluateSla({ incident: incident(), now: at(3) }).evaluated_at).toBe(at(3).toISOString());
  });
});
