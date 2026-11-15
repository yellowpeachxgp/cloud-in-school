// Unified graceful-shutdown controller — extracted so the real drain logic
// is unit-testable with fake apps/servers/clock. main.mjs wires its live
// objects; tests wire fakes. Both share this one implementation.
export function createShutdownController({
  app,
  server,
  stopBackgroundTasks,
  logLine = () => {},
  setExitCode = (code) => {
    process.exitCode = code;
  },
  maxDrainMs = 15_000,
  now = () => Date.now()
}) {
  let shutdownPromise = null;
  let deadlineMs = Infinity;

  const shutdown = (signal) => {
    if (shutdownPromise) {
      // A repeated signal accelerates the deadline, never restarts the flow.
      deadlineMs = Math.min(deadlineMs, now() + 2_000);
      return shutdownPromise;
    }
    deadlineMs = now() + maxDrainMs;
    shutdownPromise = (async () => {
      const log = (extra) =>
        logLine({ service: "cloud-api-shutdown", timestamp: new Date().toISOString(), signal, ...extra });
      log({ phase: "draining_started" });

      // 1) Stop ALL intake: background timers first, then new HTTP writes.
      stopBackgroundTasks();
      if (typeof app.setDraining === "function") app.setDraining(true);

      // 2) Bounded drain over ALL registered task kinds under ONE deadline —
      // the same deadline also bounds the socket close below.
      const settle = async () => {
        while (now() < deadlineMs) {
          const counts = typeof app.getInFlightTasks === "function" ? app.getInFlightTasks() : {};
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          if (total <= 0) return { drained: true, counts };
          await new Promise((r) => setTimeout(r, 100));
        }
        const counts = typeof app.getInFlightTasks === "function" ? app.getInFlightTasks() : {};
        return { drained: false, counts };
      };
      const { drained, counts: remaining } = await settle();
      if (drained) {
        log({ phase: "drained", drained: true });
      } else {
        // Honest state: unresolved work stays RESULT_UNKNOWN/in-flight —
        // NEVER fake-cancel, NEVER report drained.
        log({ phase: "drain_deadline", drained: false, remaining });
      }

      // 3) Strict persistence before sockets close; failure = non-success.
      let persisted = false;
      try {
        if (typeof app.store.flushSnapshotStrictSync === "function") {
          app.store.flushSnapshotStrictSync();
        } else {
          app.store.saveSnapshot();
        }
        persisted = true;
      } catch (err) {
        log({ phase: "persist_failed", drained: false, error: err?.message || String(err) });
      }

      // 4) Close the HTTP server under the SAME remaining deadline.
      const serverWaitMs = Math.max(500, deadlineMs - now());
      await Promise.race([
        new Promise((resolve) => {
          try {
            server.close(() => resolve());
            if (typeof server.closeAllConnections === "function") {
              setTimeout(() => {
                try {
                  server.closeAllConnections();
                } catch {
                  /* ignore */
                }
              }, Math.min(2_000, serverWaitMs)).unref?.();
            }
          } catch {
            resolve();
          }
        }),
        new Promise((resolve) => setTimeout(resolve, serverWaitMs))
      ]);
      log({ phase: "shutdown_complete", drained, persisted });
      setExitCode(drained && persisted ? 0 : 3);
      return { drained, persisted, remaining: drained ? {} : remaining };
    })();
    return shutdownPromise;
  };

  return { shutdown };
}
