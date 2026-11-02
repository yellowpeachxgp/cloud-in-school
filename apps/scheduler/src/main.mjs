export async function scanDueScheduleEvents(app, nowMs = Date.now()) {
  const executed = [];
  for (const ev of app.store.scheduleEvents.values()) {
    if (ev.status !== "ARMED") continue;
    const dueMs = new Date(ev.due_at).getTime();
    if (dueMs <= nowMs) {
      const res = await app.reservationEngine.runScheduleEvent(ev.job_id, ev.kind, nowMs);
      executed.push({ event_id: ev.id, job_id: ev.job_id, kind: ev.kind, status: res.event.status });
    }
  }
  return executed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ service: "triple-schedule-scanner", status: "ready" }));
}
