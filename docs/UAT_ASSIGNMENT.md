# Week 11: User acceptance testing of the assignment workflow

## Scope

The path an incident takes from "reported, nobody has it" to "someone owns it, possibly more than one person over time":
`POST /api/incidents`, `PATCH /api/incidents/:id/assignment`, how assignment interacts with status changes, the
response SLA, the audit trail, and what the dashboard shows. The dashboard is read-only, so assignment is performed
through the API and verified on the dashboard.

Personas: **requester** (reports incidents), **agent** (works them), **manager** (assigns and hands over work).

## How this was tested

1. **Automated acceptance tests**, `tests/uat.assignment.test.js`. Each scenario below is written as a person
   would walk through it and runs through the real HTTP API and database (in-memory SQLite). Run:
   `npx jest tests/uat.assignment.test.js --verbose`
2. **Manual walkthrough** on the running app with the dashboard open (section "Manual checks").

Rule changes are unit-tested in `tests/assignmentRules.domain.test.js`.

## Scenarios

Fill the Result column from the `--verbose` output (all tests in a scenario passing = Pass).

| ID | Scenario | Expected | Result |
| --- | --- | --- | --- |
| UAT-A01 | Requester reports, agent claims, works, resolves and closes | One open assignment; history new, assigned, in_progress, resolved, closed; response SLA met; audit trail has every step | |
| UAT-A02 | Manager assigns to an agent, then hands over to another; manager can also take an incident | One open assignment, the first closed; "assigned by" names the manager; audit shows assigned then reassigned | |
| UAT-A03 | A requester is assigned an incident, or tries to assign one | 400 with a clear message; nothing changes, no audit row | |
| UAT-A04 | Assign pressed twice, or two identical requests at once | 200, no duplicate assignment, no extra audit row, `assigned_at` does not move; closed incidents still refuse | |
| UAT-A05 | Malformed input: wrong types, blank or over-long reason, unknown users | 400 with a specific message (never 500); nothing written; reason trimmed, blank reason stored as nothing | |
| UAT-A06 | Closed and cancelled incidents; reopening | Assigning a closed or cancelled incident gives 409; after reopening, assignment works | |
| UAT-A07 | Assigning an incident that is on hold | Assignee changes, status stays on_hold, SLA stays paused | |
| UAT-A08 | Response SLA across handoffs | First assignment decides it (met or breached); a later handoff does not change it | |
| UAT-A09 | Incident list reflects assignment | Assignee name appears after assigning and changes on handoff; cannot leave "new" without an assignee | |

## Defects found and fixed

Found by walking each scenario against the Week 10 `assignIncident` code; each has a test in `tests/uat.assignment.test.js` that covers it.

| # | Severity | What happened | Fix |
| --- | --- | --- | --- |
| D1 | Medium | Assigning an incident to the person who already has it (double click, retry, two tabs) closed their assignment and opened an identical one, moved `assigned_at`, and wrote a "reassigned" audit row with no changes. Assignment history filled with duplicates. | Same-assignee assignment is a no-op: 200, nothing written. |
| D2 | Medium | Any user could be assigned an incident, including a requester, and a requester could assign incidents to others. | Assignee and assigner must be agent, manager or admin (400 otherwise). `domain/assignmentRules.js`. |
| D3 | Medium | `assignedTo`, `assignedBy` or `reason` of the wrong type (an object or array) went to the database driver and came back as a 500 "Internal server error". | Type checks return 400 with a specific message. |
| D4 | Low | `reason` was stored as sent: unlimited length, leading/trailing spaces, whitespace-only values. | Trimmed, max 500 characters, blank stored as nothing. |

Existing behaviour that was checked and works: closed and cancelled incidents are refused (409), concurrent
assignments to different people leave exactly one open assignment, a failed history or audit write rolls the
whole assignment back, and nothing can move past "new" without going through assignment.

## Open decisions (not changed, need a business answer)

1. **Reassigning a resolved incident** is allowed (carried over from Week 7). Should a resolved incident have to be reopened first?
2. **Team mismatch.** An incident with a team can be assigned to an agent from another team. Should that be refused or only flagged?
3. **Unassign.** There is no way to return an incident to "unassigned"; only reassign. Is one needed?
4. **Same gap on the status endpoint.** `changedBy` and `note` of the wrong type reach the driver as a 500 there too. This belongs with the request-validation layer (code review finding 26), so it was not patched piecemeal.
5. Actor identity still comes from the request body (finding 6), so "who assigned" can be forged until authentication exists.

## Manual checks (dashboard open at http://localhost:4000)

Set the variables from `node scripts/dev-data.js`, plus `$u = "http://localhost:4000/api/incidents"` and `$j = "application/json"`, then:

```powershell
$inc = Invoke-RestMethod -Method Post -Uri $u -ContentType $j -Body (@{title="UAT printer";reporterId=$reporter;categoryId=$category;priorityId=$priority} | ConvertTo-Json)
$id = $inc.id
```

| ID | Do | Expect on the dashboard / in the response | Result |
| --- | --- | --- | --- |
| M1 | Refresh the dashboard | "UAT printer" is listed as Unassigned; the Unassigned card went up by one | Pass |
| M2 | `Invoke-RestMethod -Method Patch -Uri "$u/$id/assignment" -ContentType $j -Body (@{assignedTo=$agent;assignedBy=$agent;reason="self-claim"} \| ConvertTo-Json)` then refresh | Status Assigned, assignee Amara Agent, Unassigned card went down by one | Pass |
| M3 | Repeat the M2 command | Succeeds; open the incident: still **one** entry in Assignment history | Pass |
| M4 | Reassign with `assignedTo=$agent2` and `reason="handoff"`, refresh, open the incident | Assignee Omar Agent; Assignment history has two entries, the first ending at the handoff | Pass |
| M5 | Assign with `assignedTo=$reporter` | 400 "assignedTo must be an agent, manager or admin, but user ... is a requester" | Pass |
| M6 | Assign with `-Body '{"assignedTo":{"id":"x"}}'` | 400 "assignedTo must be a user id (string)", not a 500 | Pass |
| M7 | `Invoke-RestMethod "$u/$id/audit" \| ConvertTo-Json -Depth 8` | created, assigned, reassigned; the repeat from M3 and the failures from M5 and M6 add no rows | Pass |

## Sign-off

| Automated acceptance tests | Manual checks | Open decisions raised |
| --- | --- | --- |
| (fill in from `npx jest tests/uat.assignment.test.js --verbose`) | 7 of 7 passed (M1 to M7) | 5 (see above) |