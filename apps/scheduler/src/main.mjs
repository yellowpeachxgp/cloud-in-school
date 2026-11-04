const KIND_PRIORITY = {
  FIRE: 0,
  FINAL_CHECK: 1,
  PRECHECK: 2
};

export async function scanDueScheduleEvents(app, nowMs = Date.now()) {
  const executed = [];
  const dueEvents = Array.from(app.store.scheduleEvents.values())
    .filter((ev) => ev.status === "ARMED" && new Date(ev.due_at).getTime() <= nowMs)
    .sort((a, b) => {
      const pa = KIND_PRIORITY[a.kind] ?? 9;
      const pb = KIND_PRIORITY[b.kind] ?? 9;
      if (pa !== pb) return pa - pb;
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    });

  for (const ev of dueEvents) {
    try {
      const res = await app.reservationEngine.runScheduleEvent(ev.job_id, ev.kind, nowMs);
      executed.push({
        event_id: ev.id,
        job_id: ev.job_id,
        kind: ev.kind,
        status: res.event.status
      });
    } catch (err) {
      ev.diagnostic_code = err?.code || "SCHEDULER_EVENT_ERROR";
      executed.push({
        event_id: ev.id,
        job_id: ev.job_id,
        kind: ev.kind,
        status: "ERROR",
        error: err?.message || String(err)
      });
    }
  }
  return executed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ service: "triple-schedule-scanner", status: "ready" }));
}
