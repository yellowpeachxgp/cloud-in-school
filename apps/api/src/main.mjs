import { createCampusCloudApp } from "./app.mjs";
import { createShutdownController } from "./shutdown.mjs";
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
  if (typeof app.isDraining === "function" && app.isDraining()) return;
  isScanning = true;
  const task = app.registerLifecycleTask("scanner");
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
    app.unregisterLifecycleTask(task);
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
    app.unregisterLifecycleTask(task);
  }
}, 5_000);
financeWorkerTimer.unref?.();

// Unified graceful shutdown — shared controller (apps/api/src/shutdown.mjs):
// one idempotent promise, single absolute deadline covering drain AND socket
// close, honest exit status.
const shutdownController = createShutdownController({
  app,
  server,
  stopBackgroundTasks: () => {
    financeWorkerStopped = true;
    clearInterval(financeWorkerTimer);
    clearInterval(scannerTimer);
  },
  logLine: (line) => console.log(JSON.stringify(line)),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  maxDrainMs: 15_000
});
const shutdown = shutdownController.shutdown;
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
