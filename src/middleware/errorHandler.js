const env = require("../config/env");

// Route/service code throws errors with `err.statusCode` and
// `err.isOperational = true` for expected failures (validation, not found,
// etc.). Anything else is treated as a bug: logged in full, masked from the
// client, and reported as a 500.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const isOperational = err.isOperational ?? status < 500;

  if (!isOperational) {
    console.error(err);
  }

  res.status(status).json({
    error: {
      message: isOperational ? err.message : "Internal server error",
      ...(env.nodeEnv !== "production" && !isOperational
        ? { stack: err.stack }
        : {}),
    },
  });
}

module.exports = errorHandler;
