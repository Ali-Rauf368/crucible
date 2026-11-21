import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { requireRole, requireKey, audit } from "../lib/auth.js";
import { FaultSpec } from "../chaos/faults.js";
import { AssertionSpec } from "../eval/assertions.js";
import { compare } from "../eval/compare.js";
import { createRun, cancelRun, waitForRun } from "../services/runner.js";
import { traces } from "../lib/traceStore.js";

export const coreRouter = Router();
const viewer = requireRole("viewer"), engineer = requireRole("engineer");
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);
const Thresholds = z.object({ overall: z.number().min(0).max(1), maxRegression: z.number().min(0).max(1), maxCostIncreasePct: z.number().min(0).max(1000) });

// ---- agents ----
coreRouter.get("/api/agents", viewer, async (_req, res) => {
  res.json(await q(`SELECT a.*, (SELECT row_to_json(x) FROM (SELECT r.id, r.scores, r.finished_at, s.name AS suite FROM runs r JOIN suites s ON s.id = r.suite_id WHERE r.agent_id = a.id AND r.status = 'completed' ORDER BY r.finished_at DESC LIMIT 1) x) AS last_run,
    (SELECT count(*)::int FROM runs r WHERE r.agent_id = a.id) AS runs FROM agents a ORDER BY a.id`));
});
const AgentIn = z.object({ slug: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2).max(80), description: z.string().max(500).default(""), kind: z.literal("http"), endpoint: z.string().url(), config: z.record(z.unknown()).default({}) });
coreRouter.post("/api/agents", engineer, async (req, res) => {
  const b = AgentIn.parse(req.body);
  const a = await one("INSERT INTO agents (slug, name, description, kind, endpoint, config) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (slug) DO NOTHING RETURNING *", [b.slug, b.name, b.description, b.kind, b.endpoint, JSON.stringify(b.config)]);
  if (!a) return void res.status(409).json({ error: "conflict", message: "Slug already exists" });
  await audit(req.user!.email, "agent.create", `agent:${a.id}`, { slug: b.slug, endpoint: b.endpoint }, req.ip);
  res.status(201).json(a);
});
coreRouter.delete("/api/agents/:id", engineer, async (req, res) => {
  const a = await one("DELETE FROM agents WHERE id = $1 AND kind = 'http' RETURNING slug", [id(req.params.id)]);
  if (!a) return void res.status(404).json({ error: "not_found", message: "Only registered HTTP agents can be removed" });
  await audit(req.user!.email, "agent.delete", `agent:${req.params.id}`, a, req.ip);
  res.json({ ok: true });
});

// ---- suites & scenarios ----
coreRouter.get("/api/suites", viewer, async (_req, res) => {
  res.json(await q(`SELECT s.*, (SELECT count(*)::int FROM scenarios c WHERE c.suite_id = s.id AND c.enabled) AS scenarios,
      (SELECT count(*)::int FROM scenarios c WHERE c.suite_id = s.id AND c.enabled AND jsonb_array_length(c.faults) > 0) AS chaos_scenarios,
      (SELECT row_to_json(x) FROM (SELECT r.id, r.label, r.scores, r.summary, r.finished_at FROM runs r WHERE r.suite_id = s.id AND r.status = 'completed' ORDER BY r.finished_at DESC LIMIT 1) x) AS last_run,
      (SELECT json_agg(x ORDER BY x.finished_at) FROM (SELECT (r.scores->>'overall')::float AS overall, r.finished_at FROM runs r WHERE r.suite_id = s.id AND r.status = 'completed' ORDER BY r.finished_at DESC LIMIT 12) x) AS trend
    FROM suites s ORDER BY s.id`));
});
coreRouter.get("/api/suites/:id", viewer, async (req, res) => {
  const s = await one("SELECT * FROM suites WHERE id = $1", [id(req.params.id)]);
  if (!s) return void res.status(404).json({ error: "not_found" });
  const [scenarios, runs] = await Promise.all([
    q("SELECT * FROM scenarios WHERE suite_id = $1 ORDER BY id", [s.id]),
    q("SELECT r.id, r.label, r.status, r.scores, r.summary, r.created_at, r.finished_at, r.is_baseline, r.trigger, a.name AS agent FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.suite_id = $1 ORDER BY r.created_at DESC LIMIT 30", [s.id]),
  ]);
  res.json({ ...s, scenarios, runs });
});
const SuiteIn = z.object({ name: z.string().min(3).max(120), description: z.string().max(1000).default(""), rubric: z.string().max(4000).default(""), thresholds: Thresholds.default({ overall: 0.7, maxRegression: 0.05, maxCostIncreasePct: 25 }) });
coreRouter.post("/api/suites", engineer, async (req, res) => {
  const b = SuiteIn.parse(req.body);
  const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Date.now().toString(36).slice(-4);
  const s = await one("INSERT INTO suites (slug, name, description, rubric, thresholds) VALUES ($1,$2,$3,$4,$5) RETURNING *", [slug, b.name, b.description, b.rubric, JSON.stringify(b.thresholds)]);
  await audit(req.user!.email, "suite.create", `suite:${s.id}`, { name: b.name }, req.ip);
  res.status(201).json(s);
});
coreRouter.put("/api/suites/:id", engineer, async (req, res) => {
  const b = SuiteIn.partial().parse(req.body);
  const s = await one(`UPDATE suites SET name = COALESCE($2, name), description = COALESCE($3, description), rubric = COALESCE($4, rubric), thresholds = COALESCE($5, thresholds), updated_at = now() WHERE id = $1 RETURNING *`,
    [id(req.params.id), b.name ?? null, b.description ?? null, b.rubric ?? null, b.thresholds ? JSON.stringify(b.thresholds) : null]);
  if (!s) return void res.status(404).json({ error: "not_found" });
  await audit(req.user!.email, "suite.update", `suite:${s.id}`, b, req.ip);
  res.json(s);
});
const ScenarioIn = z.object({
  name: z.string().min(3).max(160), category: z.string().min(2).max(40).default("functional"), input: z.string().min(1).max(8000), expected: z.string().max(4000).default(""),
  assertions: z.array(AssertionSpec).max(30).default([]), faults: z.array(FaultSpec).max(10).default([]), tags: z.array(z.string().max(30)).max(10).default([]), critical: z.boolean().default(false), enabled: z.boolean().default(true),
});
coreRouter.post("/api/suites/:id/scenarios", engineer, async (req, res) => {
  const b = ScenarioIn.parse(req.body);
  const sc = await one(`INSERT INTO scenarios (suite_id, name, category, input, expected, assertions, faults, tags, critical, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id(req.params.id), b.name, b.category, b.input, b.expected, JSON.stringify(b.assertions), JSON.stringify(b.faults), b.tags, b.critical, b.enabled]);
  await audit(req.user!.email, "scenario.create", `scenario:${sc.id}`, { name: b.name }, req.ip);
  res.status(201).json(sc);
});
coreRouter.put("/api/scenarios/:id", engineer, async (req, res) => {
  const b = ScenarioIn.parse(req.body);
  const sc = await one(`UPDATE scenarios SET name=$2, category=$3, input=$4, expected=$5, assertions=$6, faults=$7, tags=$8, critical=$9, enabled=$10 WHERE id = $1 RETURNING *`,
    [id(req.params.id), b.name, b.category, b.input, b.expected, JSON.stringify(b.assertions), JSON.stringify(b.faults), b.tags, b.critical, b.enabled]);
  if (!sc) return void res.status(404).json({ error: "not_found" });
  await audit(req.user!.email, "scenario.update", `scenario:${sc.id}`, { name: b.name }, req.ip);
  res.json(sc);
});
coreRouter.delete("/api/scenarios/:id", engineer, async (req, res) => {
  await q("DELETE FROM scenarios WHERE id = $1", [id(req.params.id)]);
  await audit(req.user!.email, "scenario.delete", `scenario:${req.params.id}`, {}, req.ip);
  res.json({ ok: true });
});

// ---- runs ----
const RunIn = z.object({ suiteId: z.number().int(), agentId: z.number().int(), label: z.string().max(120).optional(), seed: z.number().int().positive().optional(), repeats: z.number().int().min(1).max(10).default(1), chaos: z.boolean().default(true), scenarioIds: z.array(z.number().int()).optional(), baseline: z.boolean().default(false) });
coreRouter.post("/api/runs", engineer, async (req, res) => {
  const b = RunIn.parse(req.body);
  const run = await createRun({ ...b, trigger: "manual", createdBy: req.user!.email });
  await audit(req.user!.email, "run.create", `run:${run.id}`, { suiteId: b.suiteId, agentId: b.agentId, seed: run.seed, chaos: b.chaos }, req.ip);
  res.status(201).json(run);
});
coreRouter.get("/api/runs", viewer, async (req, res) => {
  const f = z.object({ suite: z.coerce.number().optional(), agent: z.coerce.number().optional(), status: z.string().optional(), limit: z.coerce.number().max(200).default(50) }).parse(req.query);
  res.json(await q(`SELECT r.*, s.name AS suite, s.slug AS suite_slug, a.name AS agent, a.slug AS agent_slug FROM runs r JOIN suites s ON s.id = r.suite_id JOIN agents a ON a.id = r.agent_id
    WHERE ($1::int IS NULL OR r.suite_id = $1) AND ($2::int IS NULL OR r.agent_id = $2) AND ($3::text IS NULL OR r.status = $3) ORDER BY r.created_at DESC LIMIT $4`, [f.suite ?? null, f.agent ?? null, f.status ?? null, f.limit]));
});
coreRouter.get("/api/runs/:id", viewer, async (req, res) => {
  const run = await one(`SELECT r.*, s.name AS suite, s.thresholds, a.name AS agent, a.slug AS agent_slug, a.config AS agent_config FROM runs r JOIN suites s ON s.id = r.suite_id JOIN agents a ON a.id = r.agent_id WHERE r.id = $1`, [id(req.params.id)]);
  if (!run) return void res.status(404).json({ error: "not_found" });
  const cases = await q(`SELECT id, scenario_id, scenario_name, session_id, category, critical, attempt, status, passed, outcome, scores, latency_ms, cost_usd, tokens_in, tokens_out, llm_calls, tool_calls, faults_injected, faults_planned, loop_detected, error FROM run_cases WHERE run_id = $1 ORDER BY id`, [run.id]);
  const baseline = await one("SELECT id, label FROM runs WHERE suite_id = $1 AND is_baseline AND status = 'completed' AND id <> $2 ORDER BY finished_at DESC LIMIT 1", [run.suite_id, run.id]);
  res.json({ ...run, cases, baseline });
});
coreRouter.get("/api/cases/:id", viewer, async (req, res) => {
  const c = await one("SELECT c.*, s.input, s.expected, s.assertions AS assertion_specs FROM run_cases c LEFT JOIN scenarios s ON s.id = c.scenario_id WHERE c.id = $1", [id(req.params.id)]);
  if (!c) return void res.status(404).json({ error: "not_found" });
  const spans = c.trace_id ? await traces.byTrace(c.trace_id) : [];
  res.json({ ...c, spans });
});
coreRouter.post("/api/runs/:id/cancel", engineer, async (req, res) => {
  const ok = await cancelRun(id(req.params.id));
  await audit(req.user!.email, "run.cancel", `run:${req.params.id}`, {}, req.ip);
  res.status(ok ? 200 : 409).json({ ok });
});
coreRouter.post("/api/runs/:id/baseline", engineer, async (req, res) => {
  const r = await one("SELECT suite_id, status FROM runs WHERE id = $1", [id(req.params.id)]);
  if (!r || r.status !== "completed") return void res.status(409).json({ error: "conflict", message: "Only completed runs can be baselines" });
  await q("UPDATE runs SET is_baseline = (id = $1) WHERE suite_id = $2 AND (is_baseline OR id = $1)", [id(req.params.id), r.suite_id]);
  await audit(req.user!.email, "run.baseline", `run:${req.params.id}`, {}, req.ip);
  res.json({ ok: true });
});

async function comparison(baseId: number, candId: number) {
  const [b, c] = await Promise.all([one("SELECT r.*, s.thresholds FROM runs r JOIN suites s ON s.id = r.suite_id WHERE r.id = $1", [baseId]), one("SELECT r.*, s.thresholds FROM runs r JOIN suites s ON s.id = r.suite_id WHERE r.id = $1", [candId])]);
  if (!b || !c) throw Object.assign(new Error("run not found"), { status: 404 });
  if (b.suite_id !== c.suite_id) throw Object.assign(new Error("runs belong to different suites"), { status: 400 });
  const [bc, cc] = await Promise.all([q("SELECT * FROM run_cases WHERE run_id = $1", [b.id]), q("SELECT * FROM run_cases WHERE run_id = $1", [c.id])]);
  return compare(b, c, bc, cc, c.thresholds);
}
coreRouter.get("/api/compare", viewer, async (req, res) => {
  const { base, cand } = z.object({ base: z.coerce.number(), cand: z.coerce.number() }).parse(req.query);
  res.json(await comparison(base, cand));
});

// ---- CI gate (API key, scope "ci") ----
const CiIn = z.object({ suite: z.string(), agent: z.string(), label: z.string().max(120).optional(), gitSha: z.string().max(64).optional(), baseline: z.union([z.literal("auto"), z.number().int()]).default("auto"), seed: z.number().int().positive().optional(), repeats: z.number().int().min(1).max(10).default(1), wait: z.boolean().default(true), timeoutSec: z.number().int().min(10).max(3600).default(900) });
coreRouter.post("/api/ci/runs", requireKey("ci"), async (req, res) => {
  const b = CiIn.parse(req.body);
  const [suite, agent] = await Promise.all([one("SELECT * FROM suites WHERE slug = $1 OR id::text = $1", [b.suite]), one("SELECT * FROM agents WHERE slug = $1 OR id::text = $1", [b.agent])]);
  if (!suite || !agent) return void res.status(404).json({ error: "not_found", message: "Unknown suite or agent" });
  const base = b.baseline === "auto" ? await one("SELECT id, seed FROM runs WHERE suite_id = $1 AND is_baseline AND status = 'completed' ORDER BY finished_at DESC LIMIT 1", [suite.id]) : await one("SELECT id, seed FROM runs WHERE id = $1", [b.baseline]);
  // same seed as the baseline → identical fault schedule, so differences come from the agent
  const run = await createRun({ suiteId: suite.id, agentId: agent.id, label: b.label ?? `CI ${b.gitSha?.slice(0, 7) ?? ""}`.trim(), gitSha: b.gitSha, seed: b.seed ?? base?.seed, repeats: b.repeats, trigger: "ci", createdBy: `key:${req.apiKey!.name}` });
  await audit(`key:${req.apiKey!.name}`, "ci.run", `run:${run.id}`, { suite: suite.slug, agent: agent.slug, gitSha: b.gitSha }, req.ip);
  if (!b.wait) return void res.status(202).json({ runId: run.id, status: run.status });
  const done = await waitForRun(run.id, b.timeoutSec * 1000);
  const report = base ? await comparison(base.id, done.id) : null;
  const passed = report ? report.gate.passed : (done.scores?.overall ?? 0) >= suite.thresholds.overall;
  res.status(passed ? 200 : 422).json({ runId: done.id, status: done.status, scores: done.scores, summary: done.summary, baselineRunId: base?.id ?? null, gate: report?.gate ?? { passed, reasons: passed ? [] : [`overall below ${suite.thresholds.overall}`] }, deltas: report?.deltas ?? null, regressions: report?.regressions ?? [], reportUrl: base ? `/compare?base=${base.id}&cand=${done.id}` : `/runs/${done.id}` });
});
coreRouter.get("/api/ci/runs/:id", requireKey("ci"), async (req, res) => {
  const r = await one("SELECT id, status, done, total, scores, summary FROM runs WHERE id = $1", [id(req.params.id)]);
  if (!r) return void res.status(404).json({ error: "not_found" });
  res.json(r);
});
