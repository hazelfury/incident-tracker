// An error that's expected to happen sometimes (bad input, missing
// resource, invalid state transition) rather than a bug. errorHandler uses
// statusCode + isOperational to decide what the client sees: the real
// message here, versus a generic "Internal server error" for anything else.
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

module.exports = { HttpError };
