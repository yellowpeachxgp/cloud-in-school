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

// Graceful shutdown: stop pulling new work; let in-flight debits finish within
// a bounded window so recovery markers stay consistent on restart.
function shutdownFinanceWorker() {
  financeWorkerStopped = true;
  clearInterval(financeWorkerTimer);
}
process.on("SIGTERM", shutdownFinanceWorker);
process.on("SIGINT", shutdownFinanceWorker);

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
