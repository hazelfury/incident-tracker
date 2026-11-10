// The app's source of "now" for lifecycle timestamps (created, assigned,
// resolved, closed, history rows). Production code just uses the real clock.
// Tests swap the source so every step gets an exact, distinct timestamp: no
// sleeping between requests, and no flaky ordering when two steps would
// otherwise land in the same millisecond.
let source = () => new Date();

module.exports = {
  now: () => source(),
  setSource(fn) {
    source = fn;
  },
  reset() {
    source = () => new Date();
  },
};
