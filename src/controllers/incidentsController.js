const asyncHandler = require("../middleware/asyncHandler");
const incidentService = require("../services/incidentService");

exports.create = asyncHandler(async (req, res) => {
  const incident = await incidentService.createIncident({
    title: req.body.title,
    description: req.body.description,
    reporterId: req.body.reporterId,
    categoryId: req.body.categoryId,
    priorityId: req.body.priorityId,
    teamId: req.body.teamId,
  });
  res.status(201).json(incident);
});

exports.list = asyncHandler(async (req, res) => {
  const incidents = await incidentService.listIncidents();
  res.json(incidents);
});

exports.getById = asyncHandler(async (req, res) => {
  const incident = await incidentService.getIncidentById(req.params.id);
  res.json(incident);
});

exports.updateAssignment = asyncHandler(async (req, res) => {
  const incident = await incidentService.assignIncident({
    incidentId: req.params.id,
    assignedTo: req.body.assignedTo,
    assignedBy: req.body.assignedBy,
    reason: req.body.reason,
  });
  res.json(incident);
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const incident = await incidentService.updateStatus({
    incidentId: req.params.id,
    toStatus: req.body.status,
    changedBy: req.body.changedBy,
    note: req.body.note,
  });
  res.json(incident);
});
