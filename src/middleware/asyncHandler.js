// Wraps an async route handler so rejected promises reach errorHandler
// instead of becoming unhandled rejections. Avoids a try/catch in every route.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
