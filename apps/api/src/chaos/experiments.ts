import { one, q } from "../db/pool.js";
import { FaultSpec } from "./faults.js";

/**
 * Live chaos experiments: inject a fault into a percentage of *real* proxy traffic (calls without a test
 * session). Safety rails: blast-radius cap (max_injections), mandatory expiry, instant kill switch, and the
 * cache is only 2 s so a stop takes effect almost immediately on every replica.
 */
export interface Experiment { id: number; name: string; fault: FaultSpec; traffic_pct: number; max_injections: number }
let cache: { at: number; list: Experiment[] } = { at: 0, list: [] };

export async function activeExperiments(): Promise<Experiment[]> {
  if (Date.now() - cache.at < 2000) return cache.list;
  await q("UPDATE experiments SET status = 'completed', stop_reason = 'expired', stopped_at = now() WHERE status = 'running' AND expires_at < now()");
  const rows = await q("SELECT id, name, fault, traffic_pct, max_injections FROM experiments WHERE status = 'running'");
  cache = { at: Date.now(), list: rows.map((r) => ({ ...r, fault: FaultSpec.parse(r.fault) })) };
  return cache.list;
}
export const invalidateExperiments = () => { cache.at = 0; };

/** Picks at most one experiment for this call; counts eligibility and reserves an injection atomically. */
export async function pickExperiment(kind: "llm" | "tool", tool?: string) {
  for (const e of await activeExperiments()) {
    const t = e.fault.target;
    if (!(t === kind || (t.startsWith("tool:") && kind === "tool" && t.slice(5) === tool))) continue;
    const hit = Math.random() * 100 < e.traffic_pct;
    const r = await one(`WITH cur AS (SELECT id, ($2 AND injected < max_injections) AS fire FROM experiments WHERE id = $1 AND status = 'running' FOR UPDATE)
      UPDATE experiments x SET eligible = eligible + 1, injected = injected + cur.fire::int,
        status = CASE WHEN cur.fire AND x.injected + 1 >= x.max_injections THEN 'completed' ELSE x.status END,
        stop_reason = CASE WHEN cur.fire AND x.injected + 1 >= x.max_injections THEN 'blast radius reached' ELSE x.stop_reason END,
        stopped_at = CASE WHEN cur.fire AND x.injected + 1 >= x.max_injections THEN now() ELSE x.stopped_at END
      FROM cur WHERE x.id = cur.id RETURNING cur.fire, x.status`, [e.id, hit]);
    if (r?.status !== "running") invalidateExperiments();
    if (r?.fire) return e;
  }
  return null;
}
