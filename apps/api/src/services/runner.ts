import crypto from "node:crypto";
import { one, q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { enqueue, registerHandler } from "../lib/queue.js";
import { publish } from "../lib/bus.js";
import { sign } from "../lib/auth.js";
import { startSpan, flushSpans, SpanStatusCode, SpanKind } from "../lib/tracing.js";
import { traces } from "../lib/traceStore.js";
import { BUILTIN, callHttpAgent } from "../agents/index.js";
import { canaryFor } from "../agents/contract.js";
import { evaluate, AssertionSpec } from "../eval/assertions.js";
import { judge } from "../eval/judge.js";
import { classify, score, summarize, type Scores } from "../eval/score.js";

let selfUrl = env.PUBLIC_URL;
export const setSelfUrl = (u: string) => { selfUrl = u; };
const CASE_TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_MS ?? 25_000);

export async function createRun(o: { suiteId: number; agentId: number; label?: string; seed?: number; repeats?: number; chaos?: boolean; trigger?: string; gitSha?: string; createdBy?: string; scenarioIds?: number[]; baseline?: boolean }) {
  const [suite, agent] = await Promise.all([one("SELECT * FROM suites WHERE id = $1", [o.suiteId]), one("SELECT * FROM agents WHERE id = $1", [o.agentId])]);
  if (!suite || !agent) throw Object.assign(new Error("suite or agent not found"), { status: 404 });
  const scenarios = await q("SELECT * FROM scenarios WHERE suite_id = $1 AND enabled ORDER BY id", [o.suiteId]);
  const chosen = o.scenarioIds?.length ? scenarios.filter((s) => o.scenarioIds!.includes(s.id)) : scenarios;
  if (!chosen.length) throw Object.assign(new Error("suite has no enabled scenarios"), { status: 400 });
  const repeats = Math.min(10, Math.max(1, o.repeats ?? 1)), chaos = o.chaos ?? true;
  const seed = o.seed ?? crypto.randomInt(1, 2 ** 31 - 1);
  const run = await one(`INSERT INTO runs (suite_id, agent_id, label, status, trigger, git_sha, seed, repeats, chaos, total, created_by, is_baseline) VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [suite.id, agent.id, o.label || `${agent.name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, o.trigger ?? "manual", o.gitSha ?? null, seed, repeats, chaos, chosen.length * repeats, o.createdBy ?? null, !!o.baseline]);
  for (const s of chosen) for (let a = 1; a <= repeats; a++) {
    const c = await one(`INSERT INTO run_cases (run_id, scenario_id, scenario_name, category, critical, attempt, session_id, faults_planned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [run.id, s.id, s.name, s.category, s.critical, a, `ses_${crypto.randomBytes(12).toString("hex")}`, JSON.stringify(chaos ? s.faults : [])]);
    await enqueue("run.case", { caseId: c.id }, { dedupeKey: `case-${c.id}`, maxAttempts: 1 });
  }
  await publish({ type: "run.created", runId: run.id, status: "queued", progress: { done: 0, total: run.total } });
  return run;
}

export async function runCase(caseId: number) {
  // queued, or abandoned by a crashed worker (the queue re-delivers stale jobs): claim it
  const c = await one(`UPDATE run_cases SET status = 'running', started_at = now(), call_counts = '{}', faults_injected = '[]', unsafe_actions = '[]', loop_detected = false, llm_calls = 0, tool_calls = 0, tokens_in = 0, tokens_out = 0, cost_usd = 0
    WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND started_at < now() - make_interval(secs => $2))) RETURNING *`, [caseId, (CASE_TIMEOUT_MS / 1000) * 3]);
  if (!c) return;
  const run = await one("SELECT r.*, a.slug AS agent_slug, a.kind AS agent_kind, a.endpoint, a.config AS agent_config, s.rubric, s.thresholds FROM runs r JOIN agents a ON a.id = r.agent_id JOIN suites s ON s.id = r.suite_id WHERE r.id = $1", [c.run_id]);
  if (run.status === "cancelled") { await q("UPDATE run_cases SET status = 'errored', error = 'cancelled', finished_at = now() WHERE id = $1", [caseId]); return finishRunIfDone(run.id); }
  if (run.status === "queued") { await q("UPDATE runs SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'", [run.id]); await publish({ type: "run.updated", runId: run.id, status: "running" }); }
  const scenario = await one("SELECT * FROM scenarios WHERE id = $1", [c.scenario_id]);

  const root = startSpan(`invoke_agent ${run.agent_slug}`, { "crucible.span.kind": "agent", "crucible.session.id": c.session_id, "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": run.agent_slug, "crucible.run.id": run.id, "crucible.case.id": caseId, "crucible.scenario": c.scenario_name, "crucible.seed": run.seed }, undefined, SpanKind.INTERNAL);
  const ctx = root.spanContext();
  await q("UPDATE run_cases SET trace_id = $2, root_span_id = $3 WHERE id = $1", [caseId, ctx.traceId, ctx.spanId]);

  const headers = { "x-crucible-key": await sign({ id: 0, email: "agent@crucible.local", name: run.agent_slug, role: "viewer" }, "2h", "internal"), "x-crucible-session": c.session_id };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CASE_TIMEOUT_MS);
  const t0 = performance.now();
  let output = "", data: Record<string, unknown> | null = null, error: string | null = null, timedOut = false;
  try {
    const input = { input: scenario.input, sessionId: c.session_id, llmBaseUrl: `${selfUrl}/proxy/anthropic`, toolsBaseUrl: `${selfUrl}/proxy/tools`, headers, config: { ...run.agent_config, slug: run.agent_slug }, signal: ac.signal };
    const res = run.agent_kind === "builtin" ? await BUILTIN[run.agent_config.impl ?? "naive"].agent(input) : await callHttpAgent(run.endpoint, input);
    output = res.output ?? ""; data = res.data ?? null;
  } catch (e) {
    timedOut = ac.signal.aborted;
    error = timedOut ? `case exceeded ${CASE_TIMEOUT_MS} ms` : (e as Error).message;
    root.recordException(e as Error);
  } finally { clearTimeout(timer); }
  const latencyMs = Math.round(performance.now() - t0);

  await flushSpans();
  const [row, spans] = await Promise.all([one("SELECT * FROM run_cases WHERE id = $1", [caseId]), traces.bySession(c.session_id)]);
  const toolsCalled = spans.filter((s) => s.kind === "tool" && s.status === "ok").map((s) => String(s.attributes["gen_ai.tool.name"]));
  const canary = run.agent_kind === "builtin" ? canaryFor(run.agent_slug) : (run.agent_config.canary as string | undefined) ?? null;
  const leak = !!canary && output.includes(canary);
  const unsafe = row.unsafe_actions as { tool: string }[];
  const facts = { output, data, errored: !!error, error, timedOut, latencyMs, costUsd: row.cost_usd, tokens: row.tokens_in + row.tokens_out, llmCalls: row.llm_calls, toolsCalled, loop: row.loop_detected, unsafe, canary };

  const j = await judge({
    rubric: run.rubric, scenario: c.scenario_name, input: scenario.input, expected: scenario.expected, output: error ? `(agent failed: ${error})` : output,
    facts: `faults injected: ${(row.faults_injected as { type: string; target: string }[]).map((f) => `${f.type}@${f.target}`).join(", ") || "none"}; tools called: ${toolsCalled.join(", ") || "none"}; dangerous actions executed: ${unsafe.map((u) => u.tool).join(", ") || "none"}; loop detected: ${row.loop_detected}`,
  }, { leak, unsafe: unsafe.length > 0, errored: !!error });
  const results = evaluate(AssertionSpec.array().parse(scenario.assertions ?? []), { ...facts, judge: j });
  const accurate = results.filter((r) => r.category === "accuracy").every((r) => r.passed) && j.accuracy >= 0.5;
  const overBudget = results.some((r) => ["max_cost_usd", "max_tokens", "max_latency_ms", "max_llm_calls"].includes(r.type) && !r.passed);
  const outcome = classify({ errored: !!error, timedOut, loop: row.loop_detected, unsafe: unsafe.length > 0, leak, faults: (row.faults_injected as unknown[]).length, accurate, overBudget });
  const { scores, passed } = score(results, j, outcome, run.thresholds?.overall ?? 0.7);

  root.setAttributes({ "crucible.outcome": outcome, "crucible.passed": passed, "crucible.score.overall": scores.overall, "crucible.latency_ms": latencyMs });
  if (error) root.setStatus({ code: SpanStatusCode.ERROR, message: error });
  root.end();
  await q(`UPDATE run_cases SET status = $2, passed = $3, outcome = $4, output = $5, data = $6, error = $7, scores = $8, assertions = $9, judge = $10, latency_ms = $11, finished_at = now() WHERE id = $1`,
    [caseId, error ? "errored" : "completed", passed, outcome, output.slice(0, 20_000), data ? JSON.stringify(data) : null, error, JSON.stringify(scores), JSON.stringify(results), JSON.stringify(j), latencyMs]);
  await publish({ type: "case.finished", runId: run.id, caseId, passed, scenario: c.scenario_name });
  await finishRunIfDone(run.id);
}

async function finishRunIfDone(runId: number) {
  const r = await one("UPDATE runs SET done = done + 1 WHERE id = $1 RETURNING done, total, status", [runId]);
  await publish({ type: "run.updated", runId, status: r.status, progress: { done: r.done, total: r.total } });
  if (r.done < r.total) return;
  const cases = await q("SELECT * FROM run_cases WHERE run_id = $1", [runId]);
  const agg = summarize(cases);
  const final = r.status === "cancelled" ? "cancelled" : "completed";
  await q("UPDATE runs SET status = $2, scores = $3, summary = $4, finished_at = now() WHERE id = $1", [runId, final, JSON.stringify(agg.scores), JSON.stringify(agg.summary)]);
  await publish({ type: "run.finished", runId, status: final });
}

export async function cancelRun(runId: number) {
  const r = await one("UPDATE runs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued','running') RETURNING id", [runId]);
  return !!r;
}

export async function waitForRun(runId: number, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await one("SELECT * FROM runs WHERE id = $1", [runId]);
    if (["completed", "failed", "cancelled"].includes(r.status) && (r.scores || r.status !== "completed")) return r;
    if (Date.now() > end) throw new Error("timed out waiting for run");
    await new Promise((res) => setTimeout(res, 400));
  }
}

export function registerJobs() {
  registerHandler("run.case", async ({ caseId }) => {
    try { await runCase(caseId); }
    catch (e) {
      // never leave a run hanging: record the infrastructure error on the case and count it as done
      const c = await one("UPDATE run_cases SET status = 'errored', passed = false, outcome = 'crashed', error = $2, scores = $3, finished_at = now() WHERE id = $1 AND status <> 'completed' RETURNING run_id", [caseId, `crucible: ${(e as Error).message}`, JSON.stringify({ accuracy: 0, safety: 0, resilience: 0, overall: 0 } satisfies Scores)]);
      if (c) await finishRunIfDone(c.run_id);
      throw e;
    }
  });
}
