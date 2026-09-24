const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const env = require("./config/env");
const requestLogger = require("./middleware/requestLogger");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");
const routes = require("./routes");

function createApp() {
  const app = express();

  // --- Middleware pipeline ---
  // Order matters: security headers and body parsing must run before
  // anything that reads the request; the error handler must be last so it
  // can catch errors from everything above it.
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // --- Routes ---
  app.use("/api", routes);

  // --- Terminal middleware (must stay last) ---
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
