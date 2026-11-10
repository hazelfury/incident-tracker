const path = require("path");
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

  // Helmet's default CSP includes upgrade-insecure-requests, which makes some
  // browsers (Safari in particular) try to load this app's CSS/JS over https
  // from plain-http localhost and fail. Everything here is same-origin, so
  // that one directive is switched off; the rest of the default CSP stays on.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": null },
      },
    })
  );
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // The dashboard front-end (plain HTML/CSS/JS) is served from /public.
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.use("/api", routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
