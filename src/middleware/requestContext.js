const crypto = require("crypto");
const context = require("../utils/requestContext");

const MAX_REQUEST_ID_LENGTH = 100;

// Opens the per-request context. A client-supplied X-Request-Id is kept (so a
// caller can correlate its own logs) but trimmed; otherwise one is generated.
// The id is echoed back in the response header.
function requestContext(req, res, next) {
  const supplied = req.get("x-request-id");
  const ctx = {
    requestId: supplied ? supplied.slice(0, MAX_REQUEST_ID_LENGTH) : crypto.randomUUID(),
    ip: req.ip,
    userAgent: req.get("user-agent") || null,
  };
  res.setHeader("X-Request-Id", ctx.requestId);
  context.run(ctx, next);
}

module.exports = requestContext;