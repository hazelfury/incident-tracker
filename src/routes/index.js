const express = require("express");
const healthRouter = require("./health");

const router = express.Router();

router.use("/health", healthRouter);

// Future weeks mount here, e.g.:
// router.use("/incidents", require("./incidents"));
// router.use("/users", require("./users"));
// router.use("/notifications", require("./notifications"));

module.exports = router;
