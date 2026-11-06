const KIND_PRIORITY = {
  PRECHECK: 0,
  FINAL_CHECK: 1,
  FIRE: 2
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

  // Group due events by job_id so distinct jobs run concurrently without 07:00:00 head-of-line blocking
  const eventsByJob = new Map();
  for (const ev of dueEvents) {
    if (!eventsByJob.has(ev.job_id)) {
      eventsByJob.set(ev.job_id, []);
    }
    eventsByJob.get(ev.job_id).push(ev);
  }

  // Also include RESULT_UNKNOWN jobs that need authoritative readback reconciliation (throttled to 15s)
  for (const job of app.store.reservationJobs.values()) {
    if (job.state === "RESULT_UNKNOWN" && !eventsByJob.has(job.id)) {
      const fireAtMs = new Date(job.fire_at).getTime();
      const effectiveExpiresAtMs = Math.max(
        new Date(job.expires_at).getTime(),
        fireAtMs + 1800 * 1000
      );
      const lastReconcileMs = Number(job.last_reconcile_at_ms || 0);
      if (nowMs >= fireAtMs && nowMs <= effectiveExpiresAtMs && nowMs - lastReconcileMs >= 15_000) {
        const fireEv = Array.from(app.store.scheduleEvents.values()).find(
          (e) => e.job_id === job.id && e.kind === "FIRE" && e.generation === job.generation
        );
        if (fireEv) {
          job.last_reconcile_at_ms = nowMs;
          eventsByJob.set(job.id, [fireEv]);
        }
      }
    }
  }

  const jobTasks = Array.from(eventsByJob.entries()).map(async ([jobId, jobEvents]) => {
    const jobResults = [];
    for (const ev of jobEvents) {
      try {
        const res = await app.reservationEngine.runScheduleEvent(jobId, ev.kind, nowMs);
        jobResults.push({
          event_id: ev.id,
          job_id: ev.job_id,
          kind: ev.kind,
          status: res.event.status
        });
      } catch (err) {
        ev.status = "ERROR";
        ev.actual_at = new Date(nowMs).toISOString();
        ev.diagnostic_code = err?.code || "SCHEDULER_EVENT_ERROR";
        jobResults.push({
          event_id: ev.id,
          job_id: ev.job_id,
          kind: ev.kind,
          status: "ERROR",
          error: err?.message || String(err)
        });
      }
    }
    return jobResults;
  });

  const settled = await Promise.allSettled(jobTasks);
  for (const item of settled) {
    if (item.status === "fulfilled" && Array.isArray(item.value)) {
      executed.push(...item.value);
    }
  }
  return executed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ service: "triple-schedule-scanner", status: "ready" }));
}
