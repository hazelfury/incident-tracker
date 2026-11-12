// Pure helpers for the dashboard: no DOM access, so the same file runs in the
// browser (as window.DashboardUtils) and under Jest (via require()).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DashboardUtils = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const MINUTES_PER_HOUR = 60;
  const MINUTES_PER_DAY = 1440;
  const MS_PER_MINUTE = 60000;
  const MS_PER_HOUR = 3600000;

  // The browser can't import the backend, so these two lists mirror
  // src/domain/incidentLifecycle.js. tests/dashboardUtils.sync.test.js fails
  // if they drift apart.
  const STATUS_ORDER = [
    "new",
    "assigned",
    "in_progress",
    "on_hold",
    "resolved",
    "closed",
    "cancelled",
  ];

  // Statuses where no more work is expected, so SLA timers stop mattering.
  const INACTIVE_STATUSES = ["resolved", "closed", "cancelled"];

  const STATUS_LABELS = {
    new: "New",
    assigned: "Assigned",
    in_progress: "In progress",
    on_hold: "On hold",
    resolved: "Resolved",
    closed: "Closed",
    cancelled: "Cancelled",
  };

  // A fresh object each time, so callers can't change a shared one by accident.
  const noInfo = () => ({ text: "—", tone: "none" });

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || "Unknown");
  }

  function isActive(incident) {
    return !INACTIVE_STATUSES.includes(incident.status);
  }

  // Priority level 1 is the most urgent. Anything outside 1-4 gets a neutral
  // style rather than a wrong colour.
  function priorityClass(level) {
    const n = Number(level);
    return n >= 1 && n <= 4 ? `prio-${n}` : "prio-other";
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    let s = String(value);
    // SQLite's CURRENT_TIMESTAMP default is "YYYY-MM-DD HH:MM:SS" in UTC with
    // no zone marker; make it unambiguous before parsing.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
      s = s.replace(" ", "T") + "Z";
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // The server evaluates SLA (including pausing the clock while an incident is
  // on hold). When that evaluation is present we use it; the due_at-only logic
  // below is the fallback for incidents without one.
  function resolutionSla(incident) {
    return incident.sla && incident.sla.resolution ? incident.sla.resolution : null;
  }

  // The date the SLA is judged against: the server's pause-adjusted due date
  // when present, otherwise the stored due_at.
  function effectiveDueDate(incident) {
    const sla = resolutionSla(incident);
    return parseDate(sla ? sla.due_at : incident.due_at);
  }

  function isOverdue(incident, now = new Date()) {
    if (!isActive(incident)) return false;
    const sla = resolutionSla(incident);
    if (sla) {
      if (sla.status === "not_applicable") return false;
      if (sla.breached) return true;
      const due = parseDate(sla.due_at);
      return !sla.paused && due !== null && due.getTime() < now.getTime();
    }
    const due = parseDate(incident.due_at);
    return due !== null && due.getTime() < now.getTime();
  }

  function formatDuration(ms) {
    const mins = Math.floor(Math.abs(ms) / MS_PER_MINUTE);
    if (mins < 1) return "<1m";
    const d = Math.floor(mins / MINUTES_PER_DAY);
    const h = Math.floor((mins % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
    const m = mins % MINUTES_PER_HOUR;
    if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  // SLA column text and tone, from the server's evaluation.
  function dueInfoFromSla(incident, sla, now) {
    if (sla.status === "not_applicable") return noInfo();
    if (!isActive(incident)) {
      return sla.status === "met"
        ? { text: "Resolved on time", tone: "done" }
        : { text: "Resolved late", tone: "late" };
    }
    if (sla.paused) {
      return sla.breached
        ? { text: "Breached · on hold", tone: "overdue" }
        : { text: "Paused (on hold)", tone: "paused" };
    }
    const slaDue = parseDate(sla.due_at);
    const remaining = (slaDue ? slaDue.getTime() : now.getTime() + sla.remaining_ms) - now.getTime();
    if (remaining < 0) {
      return { text: `Breached by ${formatDuration(remaining)}`, tone: "overdue" };
    }
    return {
      text: `Due in ${formatDuration(remaining)}`,
      tone: sla.status === "at_risk" || remaining < MS_PER_HOUR ? "soon" : "ok",
    };
  }

  // Fallback for incidents that carry no server-side SLA evaluation.
  function dueInfoFromDueAt(incident, now) {
    const due = parseDate(incident.due_at);
    if (incident.status === "cancelled" || !due) return noInfo();
    if (!isActive(incident)) {
      const resolved = parseDate(incident.resolved_at);
      if (!resolved) return noInfo();
      return resolved.getTime() <= due.getTime()
        ? { text: "Resolved on time", tone: "done" }
        : { text: "Resolved late", tone: "late" };
    }
    const diff = due.getTime() - now.getTime();
    if (diff < 0) {
      return { text: `Overdue by ${formatDuration(diff)}`, tone: "overdue" };
    }
    return {
      text: `Due in ${formatDuration(diff)}`,
      tone: diff < MS_PER_HOUR ? "soon" : "ok",
    };
  }

  // What to show in the SLA column, and a "tone" the UI turns into a colour.
  function dueInfo(incident, now = new Date()) {
    const sla = resolutionSla(incident);
    return sla ? dueInfoFromSla(incident, sla, now) : dueInfoFromDueAt(incident, now);
  }

  // Response SLA (time to first assignment) as text + tone, from the server's evaluation.
  function responseInfo(incident, now = new Date()) {
    const r = incident.sla && incident.sla.response;
    if (!r || r.status === "not_applicable") return noInfo();
    if (r.status === "met") return { text: "Responded on time", tone: "done" };
    if (r.status === "breached") {
      return r.responded_at
        ? { text: "Responded late", tone: "late" }
        : { text: "No response yet, target missed", tone: "overdue" };
    }
    const due = parseDate(r.due_at);
    return due
      ? { text: `Respond within ${formatDuration(due.getTime() - now.getTime())}`, tone: "ok" }
      : { text: "Awaiting response", tone: "ok" };
  }

  function formatDateTime(value) {
    const d = parseDate(value);
    if (!d) return "—";
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // filters: { status: "all" | <status>, priorityId: "" | <id>, search: "" }
  function filterIncidents(incidents, filters = {}) {
    const { status = "all", priorityId = "", search = "" } = filters;
    const q = String(search).trim().toLowerCase();

    return incidents.filter((i) => {
      if (status !== "all" && i.status !== status) return false;
      if (priorityId && i.priority_id !== priorityId) return false;
      if (q) {
        const haystack = [
          i.title,
          i.assignee_name,
          i.category_name,
          i.reporter_name,
          i.priority_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  // Active incidents first; within each group by priority (1 = most urgent),
  // then soonest due date for active ones, then newest first.
  function sortIncidents(incidents) {
    return [...incidents].sort((a, b) => {
      const ra = isActive(a) ? 0 : 1;
      const rb = isActive(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;

      const pa = a.priority_level ?? 99;
      const pb = b.priority_level ?? 99;
      if (pa !== pb) return pa - pb;

      if (ra === 0) {
        const da = effectiveDueDate(a);
        const db = effectiveDueDate(b);
        if (da && db && da.getTime() !== db.getTime()) {
          return da.getTime() - db.getTime();
        }
      }

      const ca = parseDate(a.created_at);
      const cb = parseDate(b.created_at);
      return (cb ? cb.getTime() : 0) - (ca ? ca.getTime() : 0);
    });
  }

  function countByStatus(incidents) {
    const counts = { all: incidents.length };
    STATUS_ORDER.forEach((s) => (counts[s] = 0));
    incidents.forEach((i) => {
      counts[i.status] = (counts[i.status] || 0) + 1;
    });
    return counts;
  }

  function summarize(incidents, now = new Date()) {
    const active = incidents.filter(isActive);
    return {
      open: active.length,
      criticalOpen: active.filter((i) => Number(i.priority_level) === 1).length,
      overdue: incidents.filter((i) => isOverdue(i, now)).length,
      unassigned: active.filter((i) => !i.assignee_id).length,
    };
  }

  return {
    STATUS_ORDER,
    STATUS_LABELS,
    statusLabel,
    isActive,
    priorityClass,
    parseDate,
    effectiveDueDate,
    isOverdue,
    formatDuration,
    dueInfo,
    responseInfo,
    formatDateTime,
    filterIncidents,
    sortIncidents,
    countByStatus,
    summarize,
  };
});