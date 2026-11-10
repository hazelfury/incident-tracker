const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const lookupService = require("../services/lookupService");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await lookupService.listPriorities());
  })
);

module.exports = router;
