const asyncHandler = require("../middleware/asyncHandler");
const auditService = require("../services/auditService");

// GET /api/audit-logs?entityType=&entityId=&incidentId=&actorId=&action=&from=&to=&limit=&offset=&order=
exports.list = asyncHandler(async (req, res) => {
  res.json(await auditService.list(req.query));
});

// GET /api/incidents/:id/audit   (oldest first unless ?order=desc)
exports.listForIncident = asyncHandler(async (req, res) => {
  const { limit, offset, order } = req.query;
  res.json(await auditService.listForIncident(req.params.id, { limit, offset, order }));
});