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
let isScanning = false;
let lastFinanceRetryMs = 0;
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
    if (
      nowMs - lastFinanceRetryMs >= 30_000 &&
      typeof app.financeService?.retryPendingDebits === "function"
    ) {
      lastFinanceRetryMs = nowMs;
      await app.financeService.retryPendingDebits(nowMs);
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
