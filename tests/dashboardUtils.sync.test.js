// Keeps the browser-side copy of the lifecycle lists honest, and covers the
// pause-adjusted due date used for sorting. The main dashboard-utils tests
// live in dashboardUtils.test.js.
const lifecycle = require("../src/domain/incidentLifecycle");
const DashboardUtils = require("../public/js/dashboard-utils");

describe("dashboard status lists match the backend lifecycle", () => {
  it("lists the same statuses in the same order", () => {
    expect(DashboardUtils.STATUS_ORDER).toEqual(lifecycle.STATUSES);
  });

  it("has a label for every status", () => {
    lifecycle.STATUSES.forEach((status) => {
      expect(DashboardUtils.statusLabel(status)).not.toBe(status);
    });
  });

  it.each(lifecycle.STATUSES)("treats '%s' as active or inactive like the backend", (status) => {
    expect(DashboardUtils.isActive({ status })).toBe(lifecycle.isActive(status));
  });
});

describe("effectiveDueDate", () => {
  const stored = "2026-03-02T10:00:00.000Z";
  const pauseAdjusted = "2026-03-02T16:00:00.000Z";

  it("prefers the server's pause-adjusted due date", () => {
    const incident = { due_at: stored, sla: { resolution: { due_at: pauseAdjusted } } };
    expect(DashboardUtils.effectiveDueDate(incident).toISOString()).toBe(pauseAdjusted);
  });

  it("falls back to the stored due_at when there is no SLA evaluation", () => {
    expect(DashboardUtils.effectiveDueDate({ due_at: stored }).toISOString()).toBe(stored);
  });

  it("returns null when there is no usable date", () => {
    expect(DashboardUtils.effectiveDueDate({})).toBeNull();
  });
});

describe("sortIncidents uses the pause-adjusted due date", () => {
  const base = { status: "in_progress", priority_level: 2, created_at: "2026-03-02T08:00:00.000Z" };

  it("sorts an incident whose due date was pushed out by a hold after one due sooner", () => {
    const heldLonger = {
      ...base,
      id: "held",
      due_at: "2026-03-02T10:00:00.000Z", // earlier on paper...
      sla: { resolution: { due_at: "2026-03-02T16:00:00.000Z" } }, // ...but pushed out by time on hold
    };
    const dueSoon = { ...base, id: "soon", due_at: "2026-03-02T12:00:00.000Z" };

    const order = DashboardUtils.sortIncidents([heldLonger, dueSoon]).map((i) => i.id);
    expect(order).toEqual(["soon", "held"]);
  });

  it("still sorts by stored due_at when there is no SLA evaluation", () => {
    const first = { ...base, id: "first", due_at: "2026-03-02T10:00:00.000Z" };
    const second = { ...base, id: "second", due_at: "2026-03-02T12:00:00.000Z" };

    const order = DashboardUtils.sortIncidents([second, first]).map((i) => i.id);
    expect(order).toEqual(["first", "second"]);
  });
});