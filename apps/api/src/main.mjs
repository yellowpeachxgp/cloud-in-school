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
  isFinanceWorkerTickRunning = true;
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

// Unified graceful shutdown: drain in one idempotent promise. A signal must
// stop intake AND close the listener — previously only the finance timer was
// cleared, leaving HTTP + scanner fully alive.
let shutdownPromise = null;
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const drainDeadlineMs = Date.now() + 15_000;
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

    // 2) Bounded drain: let in-flight dispatch/debit attempts finish; never
    //    mark unresolved work as cancelled or failed — RESULT_UNKNOWN stays
    //    RESULT_UNKNOWN for post-restart reconciliation.
    const settle = async () => {
      while (Date.now() < drainDeadlineMs) {
        const pending = typeof app.getInFlightWrites === "function" ? app.getInFlightWrites() : 0;
        if (pending <= 0) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    const drained = await settle();
    if (!drained) {
      log({ phase: "drain_deadline", note: "in-flight work kept in RESULT_UNKNOWN for reconcile" });
    }

    // 3) Strict persistence of recovery state before sockets close.
    try {
      if (typeof app.store.flushSnapshotStrictSync === "function") {
        app.store.flushSnapshotStrictSync();
      } else {
        app.store.saveSnapshot();
      }
    } catch (err) {
      log({ phase: "persist_failed", error: err?.message || String(err) });
    }

    // 4) Close the HTTP server (stops accepting; lets open sockets end).
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
        // closeAllConnections keeps the deadline honest on keep-alive sockets
        if (typeof server.closeAllConnections === "function") {
          setTimeout(() => {
            try { server.closeAllConnections(); } catch { /* ignore */ }
          }, 2_000).unref?.();
        }
      } catch {
        resolve();
      }
    });
    log({ phase: "shutdown_complete", drained });
    process.exitCode = 0;
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
