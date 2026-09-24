const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const db = require("../config/database");
const env = require("../config/env");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await db.healthCheck();
    res.json({
      status: "ok",
      db: { client: env.dbClient, connected: true },
      timestamp: new Date().toISOString(),
    });
  })
);

module.exports = router;
