const express = require("express");
const healthRouter = require("./health");
const incidentsRouter = require("./incidents");
const prioritiesRouter = require("./priorities");
const escalationsRouter = require("./escalations");
const auditRouter = require("./audit");

const router = express.Router();

router.use("/health", healthRouter);
router.use("/incidents", incidentsRouter);
router.use("/priorities", prioritiesRouter);
router.use("/escalations", escalationsRouter);
router.use("/audit-logs", auditRouter);

// Future weeks mount here, e.g.:
// router.use("/users", require("./users"));
// router.use("/notifications", require("./notifications"));

module.exports = router;