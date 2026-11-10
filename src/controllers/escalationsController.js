const asyncHandler = require("../middleware/asyncHandler");
const escalationService = require("../services/escalationService");

// POST /api/escalations/run            runs an escalation cycle now
// POST /api/escalations/run?dryRun=true  reports what would escalate, changes nothing
exports.run = asyncHandler(async (req, res) => {
  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true";
  const result = await escalationService.runEscalationCycle({ dryRun });
  res.json(result);
});
