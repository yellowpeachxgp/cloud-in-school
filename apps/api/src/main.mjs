import { createCampusCloudApp } from "./app.mjs";
import { scanDueScheduleEvents } from "../../scheduler/src/main.mjs";

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";
const app = createCampusCloudApp({
  storeOptions: {
    snapshotPath:
      process.env.CLOUD_SNAPSHOT_PATH || "/opt/cloud-in-school/.data/cloud-state.json",
    requireDurableSnapshot: process.env.CLOUD_REQUIRE_DURABLE_SNAPSHOT !== "false"
  }
});
const server = app.createHttpServer();

// 250ms high-precision background Triple-Schedule scanner (PRECHECK T-30m / FINAL_CHECK T-5m / FIRE T)
// The scanner ONLY scans/resolves reservation schedule events. Finance debit
// retries run on a SEPARATE worker below — a hung/slow SSO debit (8s timeout
// per order, serially) used to block this loop and stall every user's 07:00
// dispatch. The two loops hold independent locks.
let isScanning = false;
const scannerTimer = setInterval(async () => {
  if (isScanning) return;
  isScanning = true;
  try {
    const nowMs = Date.now();
    const executed = await scanDueScheduleEvents(app, nowMs);
    if (executed && executed.length > 0) {
      console.log(
        JSON.stringify({
          service: "triple-schedule-scanner",
          timestamp: new Date(nowMs).toISOString(),
          executed
        })
      );
      if (typeof app.store.saveSnapshot === "function") {
        app.store.saveSnapshot();
      }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        service: "triple-schedule-scanner",
        timestamp: new Date().toISOString(),
        error: err?.message || String(err)
      })
    );
  } finally {
    isScanning = false;
  }
}, 250);
scannerTimer.unref?.();

// Independent finance retry worker: own timer + own re-entrancy lock (inside
// retryPendingDebits), bounded batch/concurrency/backoff per order. A finance
// stall can never pause reservation scanning; a scan burst can never
// double-run a debit.
let isFinanceWorkerTickRunning = false;
let financeWorkerStopped = false;
const financeWorkerTimer = setInterval(async () => {
  if (financeWorkerStopped || isFinanceWorkerTickRunning) return;
  if (typeof app.financeService?.retryPendingDebits !== "function") return;
  if (typeof app.isDraining === "function" && app.isDraining()) return;
  isFinanceWorkerTickRunning = true;
  const task = app.registerLifecycleTask("finance");
  try {
    const res = await app.financeService.retryPendingDebits(Date.now(), {
      batchSize: Number(process.env.FINANCE_RETRY_BATCH_SIZE) || 10,
      concurrency: Number(process.env.FINANCE_RETRY_CONCURRENCY) || 3
    });
    if (res?.retried?.length) {
      console.log(
        JSON.stringify({
          service: "finance-retry-worker",
          timestamp: new Date().toISOString(),
          ...res
        })
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        service: "finance-retry-worker",
        timestamp: new Date().toISOString(),
        error: err?.message || String(err)
      })
    );
  } finally {
    isFinanceWorkerTickRunning = false;
  }
}, 5_000);
financeWorkerTimer.unref?.();

// Unified graceful shutdown: drain in one idempotent promise covering
// HTTP mutations AND background scanner/finance tasks under a single absolute
// deadline (the deadline also bounds server.close — no unbounded waits).
let shutdownPromise = null;
let shutdownDeadlineMs = Infinity;
function shutdown(signal) {
  if (shutdownPromise) {
    // A repeated signal accelerates the deadline, never starts a second flow.
    shutdownDeadlineMs = Math.min(shutdownDeadlineMs, Date.now() + 2_000);
    return shutdownPromise;
  }
  shutdownDeadlineMs = Date.now() + 15_000;
  shutdownPromise = (async () => {
    const log = (extra) =>
      console.log(
        JSON.stringify({
          service: "cloud-api-shutdown",
          timestamp: new Date().toISOString(),
          signal,
          ...extra
        })
      );
    log({ phase: "draining_started" });

    // 1) Stop all intake: scheduler scanner + finance worker + new HTTP writes.
    financeWorkerStopped = true;
    clearInterval(financeWorkerTimer);
    clearInterval(scannerTimer);
    if (typeof app.setDraining === "function") app.setDraining(true);

    // 2) Bounded drain over ALL registered task kinds under ONE deadline.
    const settle = async () => {
      while (Date.now() < shutdownDeadlineMs) {
        const counts = typeof app.getInFlightTasks === "function" ? app.getInFlightTasks() : {};
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total <= 0) return { drained: true, counts };
        await new Promise((r) => setTimeout(r, 100));
      }
      const counts = typeof app.getInFlightTasks === "function" ? app.getInFlightTasks() : {};
      return { drained: false, counts };
    };
    const { drained, counts: remaining } = await settle();
    if (!drained) {
      // Honest state: unresolved work stays RESULT_UNKNOWN/in-flight — NEVER
      // fake-cancel, NEVER report drained.
      log({ phase: "drain_deadline", drained: false, remaining });
    } else {
      log({ phase: "drained", drained: true });
    }

    // 3) Strict persistence of recovery state before sockets close; a failure
    // is a non-success shutdown — never claim recovery state is guaranteed.
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
    const serverWaitMs = Math.max(500, shutdownDeadlineMs - Date.now());
    await Promise.race([
      new Promise((resolve) => {
        try {
          server.close(() => resolve());
          if (typeof server.closeAllConnections === "function") {
            setTimeout(() => {
              try { server.closeAllConnections(); } catch { /* ignore */ }
            }, Math.min(2_000, serverWaitMs)).unref?.();
          }
        } catch {
          resolve();
        }
      }),
      new Promise((resolve) => setTimeout(resolve, serverWaitMs))
    ]);
    log({ phase: "shutdown_complete", drained, persisted });
    // Exit honestly: anything unfinished means a non-zero signal to the runner.
    process.exitCode = drained && persisted ? 0 : 3;
  })();
  return shutdownPromise;
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      service: "cloud-in-school-api",
      status: "listening",
      host,
      port,
      registered_operations: app.getRegisteredRoutes().length
    })
  );
});
