const express = require("express");
const controller = require("../controllers/escalationsController");

const router = express.Router();

router.post("/run", controller.run);

module.exports = router;
