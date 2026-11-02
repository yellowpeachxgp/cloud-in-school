export async function runSchoolWorkerOnce(app, jobId, kind = "FIRE", nowMs = Date.now()) {
  return app.reservationEngine.runScheduleEvent(jobId, kind, nowMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ service: "worker-school", status: "ready" }));
}
