const express = require("express");
const controller = require("../controllers/auditController");

const router = express.Router();

router.get("/", controller.list);

module.exports = router;