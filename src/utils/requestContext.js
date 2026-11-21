// Per-request context (request id, client address, user agent) that follows a
// request through every await, so the audit service can record where an action
// came from without each service function having to pass it along.
// Outside a request (scripts, the escalation timer) get() returns null.
const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

module.exports = {
  run: (context, fn) => storage.run(context, fn),
  get: () => storage.getStore() || null,
};