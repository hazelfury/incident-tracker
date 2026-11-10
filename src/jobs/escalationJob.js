const { runEscalationCycle } = require("../services/escalationService");

/**
 * Runs the escalation cycle once immediately and then every `intervalMs`.
 *
 * A run that is still going when the next tick fires is skipped rather than
 * stacked, so a slow database can't pile up overlapping runs. `stop()` clears
 * the timer and waits for any run already in flight, so shutdown doesn't close
 * the database underneath it.
 *
 * `runCycle` is injectable so the scheduling behaviour can be tested without a
 * database.
 */
function startEscalationJob({ intervalMs, runCycle = runEscalationCycle, logger = console } = {}) {
  let inFlight = null;

  function tick() {
    if (inFlight) return inFlight; // previous run still going: skip this tick
    inFlight = (async () => {
      try {
        const result = await runCycle();
        if (result.escalated.length) {
          logger.log(`[escalation] raised ${result.escalated.length} incident(s):`);
          result.escalated.forEach((e) =>
            logger.log(`[escalation]   ${e.title}: ${e.from_priority} -> ${e.to_priority}`)
          );
        }
        if (result.errors.length) {
          logger.error(`[escalation] ${result.errors.length} incident(s) failed to escalate`, result.errors);
        }
      } catch (err) {
        logger.error("[escalation] cycle failed", err);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    runNow: tick,
    async stop() {
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}

module.exports = { startEscalationJob };
