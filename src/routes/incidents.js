const express = require("express");
const controller = require("../controllers/incidentsController");
const auditController = require("../controllers/auditController");

const router = express.Router();

router.post("/", controller.create);
router.get("/", controller.list);
router.get("/:id", controller.getById);
router.get("/:id/audit", auditController.listForIncident);
router.patch("/:id/assignment", controller.updateAssignment);
router.patch("/:id/status", controller.updateStatus);

module.exports = router;