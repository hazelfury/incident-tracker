const express = require("express");
const healthRouter = require("./health");
const incidentsRouter = require("./incidents");

const router = express.Router();

router.use("/health", healthRouter);
router.use("/incidents", incidentsRouter);

// Future weeks mount here, e.g.:
// router.use("/users", require("./users"));
// router.use("/notifications", require("./notifications"));

module.exports = router;
