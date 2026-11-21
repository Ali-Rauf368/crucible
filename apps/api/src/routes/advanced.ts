import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { requireRole, audit } from "../lib/auth.js";
import { FaultSpec } from "../chaos/faults.js";
import { invalidateExperiments } from "../chaos/experiments.js";
import { MUTATORS, mutate, type Mutator } from "../eval/mutations.js";
import { notify, fmtInterval } from "../services/scheduler.js";
import { assertPublicUrl } from "../lib/netguard.js";
import { OWASP, owaspFor } from "../eval/owasp.js";

export const advancedRouter = Router();
const viewer = requireRole("viewer"), engineer = requireRole("engineer");
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);

// ---------- live chaos experiments ----------
advancedRouter.get("/api/experiments", viewer, async (_req, res) => {
  await q("UPDATE experiments SET status = 'completed', stop_reason = 'expired', stopped_at = now() WHERE status = 'running' AND expires_at < now()");
  res.json(await q("SELECT * FROM experiments ORDER BY (status = 'running') DESC, created_at DESC LIMIT 50"));
});
advancedRouter.post("/api/experiments", engineer, async (req, res) => {
  const b = z.object({ name: z.string().min(3).max(100), fault: FaultSpec, trafficPct: z.number().min(0.1).max(100), maxInjections: z.number().int().min(1).max(100_000).default(100), durationMinutes: z.number().int().min(1).max(24 * 60).default(30) }).parse(req.body);
  if (b.fault.type === "timeout" && (b.fault.latencyMs ?? 15000) > 30_000) return void res.status(400).json({ error: "validation_error", message: "Live timeouts are capped at 30 s" });
  const e = await one(`INSERT INTO experiments (name, fault, traffic_pct, max_injections, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6)) RETURNING *`,
    [b.name, JSON.stringify(b.fault), b.trafficPct, b.maxInjections, req.user!.email, b.durationMinutes]);
  invalidateExperiments();
  await audit(req.user!.email, "experiment.start", `experiment:${e.id}`, { fault: b.fault, trafficPct: b.trafficPct, maxInjections: b.maxInjections, durationMinutes: b.durationMinutes }, req.ip);
  res.status(201).json(e);
});
advancedRouter.post("/api/experiments/:id/stop", engineer, async (req, res) => {
  const e = await one("UPDATE experiments SET status = 'stopped', stop_reason = $2, stopped_at = now() WHERE id = $1 AND status = 'running' RETURNING *", [id(req.params.id), `stopped by ${req.user!.name}`]);
  invalidateExperiments();
  await audit(req.user!.email, "experiment.stop", `experiment:${req.params.id}`, {}, req.ip);
  res.status(e ? 200 : 409).json(e ?? { error: "conflict", message: "Experiment is not running" });
});
/** Kill switch: stops every running experiment at once. */
advancedRouter.post("/api/experiments/stop-all", engineer, async (req, res) => {
  const rows = await q("UPDATE experiments SET status = 'stopped', stop_reason = $1, stopped_at = now() WHERE status = 'running' RETURNING id", [`kill switch by ${req.user!.name}`]);
  invalidateExperiments();
  await audit(req.user!.email, "experiment.kill_switch", null, { stopped: rows.length }, req.ip);
  res.json({ stopped: rows.length });
});

// ---------- mutation fuzzing ----------
advancedRouter.get("/api/mutators", viewer, (_req, res) => { res.json(Object.entries(MUTATORS).map(([id, m]) => ({ id, ...m }))); });
advancedRouter.post("/api/scenarios/:id/mutate", engineer, async (req, res) => {
  const { strategies } = z.object({ strategies: z.array(z.enum(Object.keys(MUTATORS) as [Mutator, ...Mutator[]])).min(1).max(7) }).parse(req.body);
  const sc = await one("SELECT * FROM scenarios WHERE id = $1", [id(req.params.id)]);
  if (!sc) return void res.status(404).json({ error: "not_found" });
  const created = [];
  for (const m of strategies) {
    const name = `${sc.name} · ${MUTATORS[m].label}`;
    if (await one("SELECT 1 FROM scenarios WHERE suite_id = $1 AND name = $2", [sc.suite_id, name])) continue;
    created.push(await one(`INSERT INTO scenarios (suite_id, name, category, input, expected, assertions, faults, tags, critical, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [sc.suite_id, name, sc.category, mutate(sc.input, m), sc.expected, JSON.stringify(sc.assertions), JSON.stringify(sc.faults), [...new Set([...sc.tags, "mutation", m])], sc.critical, JSON.stringify({ type: "mutation", from: sc.id, strategy: m })]));
  }
  await audit(req.user!.email, "scenario.mutate", `scenario:${sc.id}`, { strategies, created: created.length }, req.ip);
  res.status(201).json(created);
});

// ---------- record & replay: pin a case (with its exact fault schedule) as a regression scenario ----------
advancedRouter.post("/api/cases/:id/to-scenario", engineer, async (req, res) => {
  const b = z.object({ name: z.string().min(3).max(160).optional(), suiteId: z.number().int().optional() }).parse(req.body ?? {});
  const c = await one("SELECT c.*, r.suite_id, s.input, s.expected, s.assertions, s.tags FROM run_cases c JOIN runs r ON r.id = c.run_id LEFT JOIN scenarios s ON s.id = c.scenario_id WHERE c.id = $1", [id(req.params.id)]);
  if (!c || c.input == null) return void res.status(404).json({ error: "not_found", message: "Case or its source scenario no longer exists" });
  // replay exactly: every fault that fired, pinned to the same call numbers
  const grouped = new Map<string, number[]>();
  for (const f of c.faults_injected as { type: string; target: string; call: number }[]) grouped.set(`${f.type}|${f.target}`, [...(grouped.get(`${f.type}|${f.target}`) ?? []), f.call]);
  const planned = FaultSpec.array().parse(c.faults_planned ?? []);
  const faults = [...grouped.entries()].map(([k, calls]) => {
    const [type, target] = k.split("|");
    const orig = planned.find((p) => p.type === type && (p.target === target || (p.target === "tool" && target.startsWith("tool:"))));
    return { ...(orig ?? {}), type, target, onCalls: [...new Set(calls)].sort((a, b) => a - b), probability: 1 };
  });
  const sc = await one(`INSERT INTO scenarios (suite_id, name, category, input, expected, assertions, faults, tags, critical, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [b.suiteId ?? c.suite_id, b.name ?? `Replay · ${c.scenario_name} (case #${c.id})`, c.category, c.input, c.expected, JSON.stringify(c.assertions), JSON.stringify(faults), [...new Set([...(c.tags ?? []), "replay"])], c.critical, JSON.stringify({ type: "replay", caseId: c.id, runId: c.run_id, outcome: c.outcome })]);
  await audit(req.user!.email, "scenario.replay", `case:${c.id}`, { scenarioId: sc.id }, req.ip);
  res.status(201).json(sc);
});

// ---------- flakiness ----------
advancedRouter.get("/api/suites/:id/flakiness", viewer, async (req, res) => {
  const { agent, runs } = z.object({ agent: z.coerce.number().optional(), runs: z.coerce.number().min(2).max(100).default(20) }).parse(req.query);
  const rows = await q(`WITH recent AS (SELECT id, agent_id FROM runs WHERE suite_id = $1 AND status = 'completed' AND ($2::int IS NULL OR agent_id = $2) ORDER BY finished_at DESC LIMIT $3)
    SELECT c.scenario_id, c.scenario_name, c.critical, a.name AS agent, a.id AS agent_id, c.run_id, c.attempt, c.passed, c.outcome
    FROM run_cases c JOIN recent r ON r.id = c.run_id JOIN agents a ON a.id = r.agent_id WHERE c.scores IS NOT NULL ORDER BY c.run_id, c.attempt`, [id(req.params.id), agent ?? null, runs]);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const k = `${r.agent_id}|${r.scenario_id ?? r.scenario_name}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const out = [...groups.values()].map((g) => {
    const passes = g.filter((x) => x.passed).length, n = g.length;
    let flips = 0; for (let i = 1; i < g.length; i++) if (g[i].passed !== g[i - 1].passed) flips++;
    const byRun = new Map<number, boolean[]>();
    for (const x of g) byRun.set(x.run_id, [...(byRun.get(x.run_id) ?? []), !!x.passed]);
    const multi = [...byRun.values()].filter((v) => v.length > 1);
    const passAtK = multi.length ? multi.filter((v) => v.some(Boolean)).length / multi.length : null;  // at least one of k attempts passes
    const passHatK = multi.length ? multi.filter((v) => v.every(Boolean)).length / multi.length : null; // all k attempts pass (consistency)
    const passRate = passes / n;
    const flakiness = n < 2 ? 0 : Math.min(1, flips / (n - 1) + (passRate > 0 && passRate < 1 ? 0.25 : 0));
    return { scenarioId: g[0].scenario_id, scenario: g[0].scenario_name, critical: g[0].critical, agent: g[0].agent, samples: n, passRate: Math.round(passRate * 1000) / 1000, flips, passAtK, passHatK,
      flakiness: Math.round(flakiness * 100) / 100, verdict: n < 3 ? "insufficient data" : passRate === 1 ? "stable pass" : passRate === 0 ? "stable fail" : flakiness >= 0.4 ? "flaky" : "mostly " + (passRate >= 0.5 ? "passing" : "failing"),
      history: g.slice(-12).map((x) => ({ runId: x.run_id, passed: x.passed, outcome: x.outcome })) };
  }).sort((a, b) => b.flakiness - a.flakiness || a.passRate - b.passRate);
  res.json(out);
});

// ---------- schedules ----------
const ScheduleIn = z.object({ suiteId: z.number().int(), agentId: z.number().int(), intervalMinutes: z.number().int().min(5).max(10080), webhookUrl: z.string().url().regex(/^https?:\/\//).max(500).nullable().optional(), notify: z.enum(["failures", "always", "never"]).default("failures"), enabled: z.boolean().default(true) });
advancedRouter.get("/api/schedules", viewer, async (_req, res) => {
  res.json(await q(`SELECT sc.*, s.name AS suite, a.name AS agent, r.scores AS last_scores, r.gate AS last_gate, r.finished_at AS last_finished_at,
      (SELECT json_agg(x ORDER BY x.id DESC) FROM (SELECT id, status, error, created_at FROM notifications n WHERE n.schedule_id = sc.id ORDER BY id DESC LIMIT 5) x) AS deliveries
    FROM schedules sc JOIN suites s ON s.id = sc.suite_id JOIN agents a ON a.id = sc.agent_id LEFT JOIN runs r ON r.id = sc.last_run_id ORDER BY sc.id`));
});
advancedRouter.post("/api/schedules", engineer, async (req, res) => {
  const b = ScheduleIn.parse(req.body);
  if (b.webhookUrl) await assertPublicUrl(b.webhookUrl);
  const s = await one(`INSERT INTO schedules (suite_id, agent_id, interval_minutes, webhook_url, notify, enabled, created_by, next_run_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $3)) RETURNING *`,
    [b.suiteId, b.agentId, b.intervalMinutes, b.webhookUrl ?? null, b.notify, b.enabled, req.user!.email]);
  await audit(req.user!.email, "schedule.create", `schedule:${s.id}`, { every: fmtInterval(b.intervalMinutes), webhook: !!b.webhookUrl }, req.ip);
  res.status(201).json(s);
});
advancedRouter.put("/api/schedules/:id", engineer, async (req, res) => {
  const b = ScheduleIn.partial().parse(req.body);
  if (b.webhookUrl) await assertPublicUrl(b.webhookUrl);
  const s = await one(`UPDATE schedules SET interval_minutes = COALESCE($2, interval_minutes), webhook_url = CASE WHEN $3::boolean THEN $4 ELSE webhook_url END, notify = COALESCE($5, notify), enabled = COALESCE($6, enabled) WHERE id = $1 RETURNING *`,
    [id(req.params.id), b.intervalMinutes ?? null, b.webhookUrl !== undefined, b.webhookUrl ?? null, b.notify ?? null, b.enabled ?? null]);
  if (!s) return void res.status(404).json({ error: "not_found" });
  await audit(req.user!.email, "schedule.update", `schedule:${s.id}`, b, req.ip);
  res.json(s);
});
advancedRouter.delete("/api/schedules/:id", engineer, async (req, res) => {
  await q("DELETE FROM schedules WHERE id = $1", [id(req.params.id)]);
  await audit(req.user!.email, "schedule.delete", `schedule:${req.params.id}`, {}, req.ip);
  res.json({ ok: true });
});
advancedRouter.post("/api/schedules/:id/run-now", engineer, async (req, res) => {
  const s = await one("UPDATE schedules SET next_run_at = now() - interval '1 second' WHERE id = $1 RETURNING id", [id(req.params.id)]);
  if (!s) return void res.status(404).json({ error: "not_found" });
  const { tickSchedules } = await import("../services/scheduler.js");
  await tickSchedules();
  const fresh = await one("SELECT last_run_id FROM schedules WHERE id = $1", [s.id]);
  res.json({ runId: fresh.last_run_id });
});
advancedRouter.post("/api/schedules/:id/test-webhook", engineer, async (req, res) => {
  const s = await one("SELECT sc.*, s.name AS suite, a.name AS agent FROM schedules sc JOIN suites s ON s.id = sc.suite_id JOIN agents a ON a.id = sc.agent_id WHERE sc.id = $1", [id(req.params.id)]);
  if (!s?.webhook_url) return void res.status(400).json({ error: "validation_error", message: "Schedule has no webhook URL" });
  res.json(await notify(s.id, null, s.webhook_url, { text: `:test_tube: Crucible test notification for *${s.agent}* on *${s.suite}*`, crucible: { test: true, scheduleId: s.id } }));
});

// ---------- OWASP LLM Top 10 coverage ----------
advancedRouter.get("/api/suites/:id/owasp", viewer, async (req, res) => {
  const suiteId = id(req.params.id);
  const scenarios = await q("SELECT id, name, category, tags, faults, assertions FROM scenarios WHERE suite_id = $1 AND enabled", [suiteId]);
  const latest = await q(`SELECT DISTINCT ON (r.agent_id) r.id, a.name AS agent FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.suite_id = $1 AND r.status = 'completed' ORDER BY r.agent_id, r.finished_at DESC`, [suiteId]);
  const cases = latest.length ? await q("SELECT run_id, scenario_id, passed FROM run_cases WHERE run_id = ANY($1)", [latest.map((r) => r.id)]) : [];
  const tagged = scenarios.map((s) => ({ ...s, owasp: owaspFor(s) }));
  res.json(OWASP.map((o) => {
    const sc = tagged.filter((s) => s.owasp.includes(o.id));
    return { ...o, scenarios: sc.map((s) => ({ id: s.id, name: s.name })), agents: latest.map((r) => {
      const cs = cases.filter((c) => c.run_id === r.id && sc.some((s) => s.id === c.scenario_id));
      return { agent: r.agent, runId: r.id, cases: cs.length, passRate: cs.length ? cs.filter((c) => c.passed).length / cs.length : null };
    }) };
  }));
});
