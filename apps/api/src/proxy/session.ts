import { one, q } from "../db/pool.js";
import { FaultSpec } from "../chaos/faults.js";

/** Chaos session = one run case. Counters live in Postgres so any API replica can serve any call. */
export interface Session { caseId: number; runId: number; sessionId: string; seed: number; chaos: boolean; faults: FaultSpec[]; traceId: string | null; rootSpanId: string | null; budget: number }
const cache = new Map<string, { s: Session; at: number }>();

export async function getSession(sessionId: string | undefined): Promise<Session | null> {
  if (!sessionId) return null;
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < 30_000 && hit.s.traceId) return hit.s;
  const r = await one(`SELECT c.id, c.run_id, c.session_id, c.faults_planned, c.trace_id, c.root_span_id, r.seed, r.chaos FROM run_cases c JOIN runs r ON r.id = c.run_id WHERE c.session_id = $1`, [sessionId]);
  if (!r) return null;
  const s: Session = { caseId: r.id, runId: r.run_id, sessionId, seed: r.seed, chaos: r.chaos, faults: FaultSpec.array().parse(r.faults_planned ?? []), traceId: r.trace_id, rootSpanId: r.root_span_id, budget: 40 };
  cache.set(sessionId, { s, at: Date.now() });
  return s;
}

/** Atomically bumps counters for this call and returns the call numbers used for fault decisions. */
export async function countCall(s: Session, kind: "llm" | "tool", tool?: string, signature?: string) {
  const keys = [kind, ...(tool ? [`tool:${tool}`] : []), ...(signature ? [`sig:${signature}`] : []), "total"];
  const expr = keys.reduce((acc, k) => `jsonb_set(${acc}, '{${k.replace(/'/g, "")}}', to_jsonb(COALESCE((call_counts->>'${k.replace(/'/g, "")}')::int, 0) + 1))`, "call_counts");
  const r = await one(`UPDATE run_cases SET call_counts = ${expr}, ${kind === "llm" ? "llm_calls = llm_calls + 1" : "tool_calls = tool_calls + 1"} WHERE id = $1 RETURNING call_counts, faults_injected`, [s.caseId]);
  const c = r.call_counts as Record<string, number>;
  const fired: Record<number, number> = {};
  for (const f of r.faults_injected as { index: number }[]) fired[f.index] = (fired[f.index] ?? 0) + 1;
  return { callNumber: c[kind], toolCallNumber: tool ? c[`tool:${tool}`] : undefined, signatureCount: signature ? c[`sig:${signature}`] : 0, total: c.total, fired };
}

export async function recordUsage(s: Session, u: { tokensIn?: number; tokensOut?: number; cost?: number; fault?: { index: number; type: string; target: string; call: number; at: string }; loop?: boolean; unsafe?: { tool: string; input: unknown } }) {
  await q(`UPDATE run_cases SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, cost_usd = cost_usd + $4,
      faults_injected = CASE WHEN $5::jsonb IS NULL THEN faults_injected ELSE faults_injected || $5::jsonb END,
      loop_detected = loop_detected OR $6, unsafe_actions = CASE WHEN $7::jsonb IS NULL THEN unsafe_actions ELSE unsafe_actions || $7::jsonb END WHERE id = $1`,
    [s.caseId, u.tokensIn ?? 0, u.tokensOut ?? 0, u.cost ?? 0, u.fault ? JSON.stringify([u.fault]) : null, !!u.loop, u.unsafe ? JSON.stringify([u.unsafe]) : null]);
}
