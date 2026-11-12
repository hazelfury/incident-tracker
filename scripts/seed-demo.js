const crypto = require("crypto");
const db = require("../src/config/database");
const incidentService = require("../src/services/incidentService");
const { MINUTE_MS } = require("../src/domain/slaCalculator");
const { runCli } = require("./lib/runCli");

const MS_PER_HOUR = 60 * MINUTE_MS;

// Sample incidents covering every priority and status, with a spread of ages
// so the dashboard shows overdue, due-soon and on-time cases.
// priority: 1 = Critical ... 4 = Low (matches the levels created by db:seed).
const DEMO_INCIDENTS = [
  { title: "Production database unreachable", priority: 1, category: "Software", status: "in_progress", agent: 0, ageHours: 6 },
  { title: "Payment gateway timeouts", priority: 1, category: "Network", status: "assigned", agent: 1, ageHours: 3.2 },
  { title: "SSO login loop for contractors", priority: 1, category: "Access/Account", status: "resolved", agent: 2, ageHours: 30 , lateResponse: true },
  { title: "Company VPN dropping connections", priority: 2, category: "Network", status: "new", agent: null, ageHours: 1 },
  { title: "CEO laptop will not boot", priority: 2, category: "Hardware", status: "in_progress", agent: 1, ageHours: 5 },
  { title: "Email delivery delays to external domains", priority: 2, category: "Software", status: "on_hold", agent: 0, ageHours: 14 , lateResponse: true },
  { title: "Slow VPN for remote staff", priority: 2, category: "Network", status: "new", agent: null, ageHours: 26 },
  { title: "Printer on 3rd floor offline", priority: 3, category: "Hardware", status: "new", agent: null, ageHours: 3 },
  { title: "Shared drive permission request", priority: 3, category: "Access/Account", status: "in_progress", agent: 2, ageHours: 9 },
  { title: "Wi-Fi dead zone in meeting room B", priority: 3, category: "Network", status: "resolved", agent: 1, ageHours: 30 },
  { title: "Duplicate ticket: VPN issue", priority: 3, category: "Network", status: "cancelled", agent: null, ageHours: 8 },
  { title: "Install Figma for design team", priority: 4, category: "Software", status: "assigned", agent: 0, ageHours: 20 },
  { title: "Password reset for new hire", priority: 4, category: "Access/Account", status: "closed", agent: 2, ageHours: 50 },
  { title: "Monitor flickering at desk 14", priority: 4, category: "Hardware", status: "resolved", agent: 1, ageHours: 12 },
  { title: "Keyboard replacement", priority: 4, category: "Hardware", status: "new", agent: null, ageHours: 4 },

  // Week 6: incidents old enough to be due for automatic escalation...
  { title: "Meeting room display not working", priority: 3, category: "Hardware", status: "new", agent: null, ageHours: 20 },
  { title: "Request: second monitor for new hire", priority: 4, category: "Hardware", status: "assigned", agent: 1, ageHours: 60 },
  { title: "Intermittent file server access", priority: 2, category: "Network", status: "in_progress", agent: 2, ageHours: 7 },
  // ...and one that is on hold within its target, so its SLA clock is paused.
  { title: "Waiting on vendor for replacement switch", priority: 3, category: "Network", status: "on_hold", agent: 0, ageHours: 14 },
];

// Status changes to apply after assignment, in order.
const FLOW = {
  new: [],
  assigned: [],
  in_progress: ["in_progress"],
  on_hold: ["in_progress", "on_hold"],
  resolved: ["in_progress", "resolved"],
  closed: ["in_progress", "resolved", "closed"],
  cancelled: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getOrCreateUser(name, email, role) {
  const existing = await db.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.rows.length) return existing.rows[0].id;
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
    [id, name, email, "dev-only-hash", role]
  );
  return id;
}

// The service stamps "now" on everything. Spread each incident's timestamps
// back over its intended age so the history reads realistically and the SLA
// column shows breached / at-risk / on-time cases.
//
// The assignment (first response) lands at half the priority's response target
// after creation, so most incidents were picked up in time; `lateResponse`
// incidents are picked up at 2.5x the target instead, to show a missed response SLA.
async function retime(incidentId, demo, priority) {
  const ageMs = demo.ageHours * MS_PER_HOUR;
  const createdMs = Date.now() - ageMs;
  const finalMs = ageMs * 0.85; // last event happens at 85% of the incident's age
  const iso = (ms) => new Date(ms).toISOString();

  const history = (
    await db.query(
      "SELECT id, to_status FROM incident_status_history WHERE incident_id = ? ORDER BY changed_at",
      [incidentId]
    )
  ).rows;

  const offsets = []; // ms after creation for each history row
  const wasAssigned = history.length > 1 && history[1].to_status === "assigned";
  if (wasAssigned) {
    const factor = demo.lateResponse ? 2.5 : 0.5;
    const assignedOffset = Math.min(priority.sla_response_mins * factor * MINUTE_MS, ageMs * 0.3);
    const rest = history.length - 2; // events after "assigned"
    offsets.push(0, assignedOffset);
    for (let k = 1; k <= rest; k++) {
      offsets.push(assignedOffset + k * ((finalMs - assignedOffset) / rest));
    }
  } else {
    const step = finalMs / Math.max(history.length - 1, 1);
    history.forEach((_, n) => offsets.push(n * step));
  }

  const at = {};
  for (let n = 0; n < history.length; n++) {
    const t = createdMs + offsets[n];
    at[history[n].to_status] = t;
    await db.query("UPDATE incident_status_history SET changed_at = ? WHERE id = ?", [iso(t), history[n].id]);
  }

  if (at.assigned !== undefined) {
    await db.query("UPDATE incident_assignments SET assigned_at = ? WHERE incident_id = ?", [iso(at.assigned), incidentId]);
  }

  await db.query(
    "UPDATE incidents SET created_at = ?, due_at = ?, assigned_at = ?, resolved_at = ?, closed_at = ? WHERE id = ?",
    [
      iso(createdMs),
      iso(createdMs + priority.sla_resolution_mins * MINUTE_MS),
      at.assigned !== undefined ? iso(at.assigned) : null,
      at.resolved !== undefined ? iso(at.resolved) : null,
      at.closed !== undefined ? iso(at.closed) : null,
      incidentId,
    ]
  );
}

async function main() {
  const priorities = (await db.query("SELECT id, level, sla_response_mins, sla_resolution_mins FROM priorities")).rows;
  const categories = (await db.query("SELECT id, name FROM categories")).rows;
  if (!priorities.length || !categories.length) {
    throw new Error("No priorities/categories found. Run npm run db:seed first.");
  }
  const priorityByLevel = Object.fromEntries(priorities.map((p) => [p.level, p]));
  const categoryByName = Object.fromEntries(categories.map((c) => [c.name, c.id]));

  const reporters = [
    await getOrCreateUser("Riley Requester", "riley@example.com", "requester"),
    await getOrCreateUser("Jordan Reyes", "jordan@example.com", "requester"),
  ];
  const agents = [
    await getOrCreateUser("Amara Agent", "amara@example.com", "agent"),
    await getOrCreateUser("Omar Agent", "omar@example.com", "agent"),
    await getOrCreateUser("Priya Patel", "priya@example.com", "agent"),
  ];

  let created = 0;
  let skipped = 0;

  for (const [n, demo] of DEMO_INCIDENTS.entries()) {
    const exists = await db.query("SELECT 1 FROM incidents WHERE title = ?", [demo.title]);
    if (exists.rows.length) {
      skipped++;
      continue;
    }

    const priority = priorityByLevel[demo.priority];
    const categoryId = categoryByName[demo.category];
    if (!priority || !categoryId) {
      throw new Error(`Missing priority level ${demo.priority} or category "${demo.category}". Run npm run db:seed first.`);
    }

    const reporterId = reporters[n % reporters.length];
    const incident = await incidentService.createIncident({
      title: demo.title,
      description: `Demo incident: ${demo.title.toLowerCase()}.`,
      reporterId,
      categoryId,
      priorityId: priority.id,
    });

    const agentId = demo.agent === null ? null : agents[demo.agent];

    if (demo.status === "cancelled") {
      await sleep(3);
      await incidentService.updateStatus({ incidentId: incident.id, toStatus: "cancelled", changedBy: reporterId, note: "Duplicate of an existing ticket" });
    } else if (agentId) {
      await sleep(3);
      await incidentService.assignIncident({ incidentId: incident.id, assignedTo: agentId, assignedBy: agentId });
      for (const next of FLOW[demo.status]) {
        await sleep(3);
        await incidentService.updateStatus({ incidentId: incident.id, toStatus: next, changedBy: agentId });
      }
    }

    await retime(incident.id, demo, priority);
    created++;
  }

  console.log(`Demo data: ${created} incidents created, ${skipped} already present.`);
}

runCli(main, { label: "Demo seed" });