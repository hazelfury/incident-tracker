const morgan = require("morgan");
const env = require("../config/env");

// Concise dev-friendly format locally, standard combined log format in prod.
module.exports = morgan(env.nodeEnv === "production" ? "combined" : "dev", {
  skip: () => env.nodeEnv === "test",
});
