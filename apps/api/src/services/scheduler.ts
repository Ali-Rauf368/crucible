import { one, q } from "../db/pool.js";
import { createRun } from "./runner.js";
import { assertPublicUrl } from "../lib/netguard.js";

/**
 * Scheduled runs. Every API/worker replica polls, but due schedules are claimed with SKIP LOCKED and
 * next_run_at is advanced in the same statement, so each slot fires exactly once.
 */
let timer: ReturnType<typeof setInterval> | null = null;

export async function tickSchedules() {
  const due = await q(`UPDATE schedules s SET next_run_at = now() + make_interval(mins => s.interval_minutes)
    WHERE s.id IN (SELECT id FROM schedules WHERE enabled AND next_run_at <= now() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING s.*`);
  for (const s of due) {
    try {
      const base = await one("SELECT seed FROM runs WHERE suite_id = $1 AND is_baseline AND status = 'completed' ORDER BY finished_at DESC LIMIT 1", [s.suite_id]);
      const run = await createRun({ suiteId: s.suite_id, agentId: s.agent_id, label: `Scheduled · every ${fmtInterval(s.interval_minutes)}`, seed: base?.seed, trigger: "schedule", createdBy: `schedule:${s.id}`, scheduleId: s.id });
      await q("UPDATE schedules SET last_run_id = $2, last_status = 'running' WHERE id = $1", [s.id, run.id]);
    } catch (e) { await q("UPDATE schedules SET last_status = $2 WHERE id = $1", [s.id, `error: ${(e as Error).message}`.slice(0, 200)]); }
  }
  return due.length;
}
export const fmtInterval = (m: number) => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`);
export function startScheduler(everyMs = 20_000) { if (!timer) timer = setInterval(() => { tickSchedules().catch((e) => console.error("scheduler:", e.message)); }, everyMs); }
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

/** Slack-compatible webhook ({ text } + structured `crucible` block). Every delivery is recorded. */
export async function notify(scheduleId: number | null, runId: number | null, url: string, payload: Record<string, unknown>) {
  let status: number | null = null, error: string | null = null;
  try {
    await assertPublicUrl(url); // re-checked at send time: DNS may have changed since the URL was saved
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "crucible-webhook/1.0" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000), redirect: "error" });
    status = r.status;
    if (!r.ok) error = `HTTP ${r.status}`;
  } catch (e) { error = (e as Error).message; }
  await q("INSERT INTO notifications (schedule_id, run_id, url, status, error, payload) VALUES ($1,$2,$3,$4,$5,$6)", [scheduleId, runId, url, status, error, JSON.stringify(payload)]);
  return { status, error };
}
