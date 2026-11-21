import { Router, type Request } from "express";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { requireRole, requireKey, verify, sign, createApiKey, audit } from "../lib/auth.js";
import { subscribe } from "../lib/bus.js";
import { traces } from "../lib/traceStore.js";
import { fromOtlp } from "../lib/tracing.js";
import { queueStats, queueBackend } from "../lib/queue.js";
import { FAULT_TYPES, FaultSpec, INJECTIONS } from "../chaos/faults.js";
import { ASSERTION_TYPES } from "../eval/assertions.js";
import { judgeMode } from "../eval/judge.js";
import { TOOLS } from "../proxy/tools.js";

export const platformRouter = Router();
const viewer = requireRole("viewer"), engineer = requireRole("engineer"), admin = requireRole("admin");
let selfUrl = env.PUBLIC_URL;
export const setPlatformSelfUrl = (u: string) => { selfUrl = u; };

platformRouter.get("/healthz", (_req, res) => { res.json({ ok: true }); });
platformRouter.get("/readyz", async (_req, res) => {
  try { await one("SELECT 1"); res.json({ ok: true, db: "up", traceStore: traces.backend, queue: queueBackend(), judge: judgeMode() }); }
  catch (e) { res.status(503).json({ ok: false, error: (e as Error).message }); }
});

platformRouter.get("/api/overview", viewer, async (_req, res) => {
  const [kpi, recent, trend, leaderboard, faultRows, outcomes, traffic] = await Promise.all([
    one(`SELECT count(DISTINCT r.id)::int AS runs, count(c.id)::int AS cases, COALESCE(avg(c.passed::int), 0)::float AS pass_rate,
        COALESCE(avg((c.scores->>'resilience')::float), 0)::float AS resilience, COALESCE(avg((c.scores->>'safety')::float), 0)::float AS safety,
        count(*) FILTER (WHERE c.outcome = 'loop')::int AS loops, count(*) FILTER (WHERE c.outcome = 'unsafe')::int AS unsafe,
        COALESCE(sum(jsonb_array_length(c.faults_injected)), 0)::int AS faults, COALESCE(sum(c.cost_usd), 0)::float AS cost,
        COALESCE(sum(c.tokens_in + c.tokens_out), 0)::bigint AS tokens
      FROM runs r LEFT JOIN run_cases c ON c.run_id = r.id AND c.scores IS NOT NULL WHERE r.created_at > now() - interval '7 days'`),
    q(`SELECT r.id, r.label, r.status, r.scores, r.summary, r.done, r.total, r.trigger, r.created_at, r.finished_at, r.is_baseline, s.name AS suite, a.name AS agent FROM runs r JOIN suites s ON s.id = r.suite_id JOIN agents a ON a.id = r.agent_id ORDER BY r.created_at DESC LIMIT 8`),
    q(`SELECT r.id, to_char(r.finished_at, 'MM-DD HH24:MI') AS t, a.name AS agent, (r.scores->>'overall')::float AS overall, (r.summary->>'passRate')::float AS pass_rate, (r.scores->>'resilience')::float AS resilience, (r.scores->>'safety')::float AS safety
       FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.status = 'completed' ORDER BY r.finished_at DESC LIMIT 30`),
    q(`SELECT DISTINCT ON (a.id, s.id) a.id AS agent_id, a.name AS agent, s.name AS suite, r.id AS run_id, r.scores, (r.summary->>'passRate')::float AS pass_rate, (r.summary->>'costUsd')::float AS cost, r.finished_at
       FROM runs r JOIN agents a ON a.id = r.agent_id JOIN suites s ON s.id = r.suite_id WHERE r.status = 'completed' ORDER BY a.id, s.id, r.finished_at DESC`),
    q(`SELECT f->>'type' AS type, count(DISTINCT c.id)::int AS cases, count(DISTINCT c.id) FILTER (WHERE c.passed)::int AS survived
       FROM run_cases c, jsonb_array_elements(c.faults_injected) f WHERE c.finished_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT outcome, count(*)::int AS n FROM run_cases WHERE finished_at > now() - interval '7 days' AND outcome IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    traces.stats(60),
  ]);
  res.json({ kpi, recent, trend: trend.reverse(), leaderboard, faults: faultRows, outcomes, traffic });
});

// ---- traffic & traces ----
platformRouter.get("/api/traffic", viewer, async (req, res) => {
  const f = z.object({ kind: z.enum(["llm", "tool"]).optional(), limit: z.coerce.number().max(500).default(100), before: z.string().optional() }).parse(req.query);
  res.json({ spans: await traces.recent(f), stats: await traces.stats(60), backend: traces.backend });
});
platformRouter.get("/api/traces/:traceId", viewer, async (req, res) => {
  const spans = await traces.byTrace(String(req.params.traceId));
  if (!spans.length) return void res.status(404).json({ error: "not_found" });
  res.json({ traceId: req.params.traceId, spans });
});

// ---- catalogs ----
platformRouter.get("/api/catalog", viewer, (_req, res) => {
  res.json({ faults: Object.entries(FAULT_TYPES).map(([type, d]) => ({ type, ...d })), assertions: Object.entries(ASSERTION_TYPES).map(([type, d]) => ({ type, ...d })), injections: Object.entries(INJECTIONS).map(([id, text]) => ({ id, text })), tools: TOOLS });
});

// ---- chaos playground: fire one request through the proxy with a forced fault ----
platformRouter.post("/api/playground", engineer, async (req, res) => {
  const b = z.object({ target: z.string().regex(/^(llm|[a-z_]+)$/), fault: FaultSpec.nullable().default(null), input: z.any().optional(), stream: z.boolean().default(false), model: z.string().default("crucible-mock-1") }).parse(req.body);
  const key = await sign({ ...req.user! }, "5m", "internal");
  const headers: Record<string, string> = { "content-type": "application/json", "x-crucible-key": key, ...(b.fault ? { "x-crucible-fault": JSON.stringify({ ...b.fault, target: b.target === "llm" ? "llm" : `tool:${b.target}` }) } : {}) };
  const url = b.target === "llm" ? `${selfUrl}/proxy/anthropic/v1/messages` : `${selfUrl}/proxy/tools/${b.target}`;
  const body = b.target === "llm" ? { model: b.model, max_tokens: 512, stream: b.stream, tools: TOOLS, messages: [{ role: "user", content: typeof b.input === "string" && b.input ? b.input : "Where is order AB-1001?" }] } : (b.input && typeof b.input === "object" ? b.input : {});
  const t0 = performance.now();
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
    const text = await r.text();
    let parsedOk = true; try { if (!b.stream) JSON.parse(text); } catch { parsedOk = false; }
    res.json({ status: r.status, latencyMs: Math.round(performance.now() - t0), headers: Object.fromEntries([...r.headers].filter(([k]) => ["content-type", "retry-after"].includes(k))), body: text.slice(0, 20_000), parsedOk, request: { url: url.replace(selfUrl, ""), body } });
  } catch (e) {
    res.json({ status: 0, latencyMs: Math.round(performance.now() - t0), error: ac.signal.aborted ? "client timeout after 20 s" : (e as Error).message, body: "", parsedOk: false, request: { url: url.replace(selfUrl, ""), body } });
  } finally { clearTimeout(timer); }
});

// ---- ingestion: OTLP/HTTP JSON and Apache NiFi ----
platformRouter.post("/v1/traces", requireKey("ingest"), async (req, res) => {
  const spans = fromOtlp(req.body);
  await traces.insert(spans);
  res.json({ partialSuccess: {}, accepted: spans.length });
});
const NifiRecord = z.object({
  timestamp: z.string().or(z.number()).optional(), source: z.string().max(60).default("nifi"), kind: z.enum(["llm", "tool"]).default("llm"), provider: z.string().max(60).optional(), model: z.string().max(100).optional(), tool: z.string().max(100).optional(),
  latency_ms: z.number().min(0).default(0), input_tokens: z.number().int().min(0).default(0), output_tokens: z.number().int().min(0).default(0), cost_usd: z.number().min(0).optional(),
  status: z.union([z.number(), z.string()]).default(200), prompt: z.string().max(4000).optional(), response: z.string().max(4000).optional(), trace_id: z.string().max(64).optional(), session_id: z.string().max(100).optional(),
});
/** Apache NiFi (InvokeHTTP / PutHTTP) posts batches of LLM gateway log records: JSON array or NDJSON. */
platformRouter.post("/api/ingest/nifi", requireKey("ingest"), async (req: Request, res) => {
  const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
  const items: unknown[] = Array.isArray(req.body) ? req.body : req.body && typeof req.body === "object" && Object.keys(req.body).length ? [req.body] : raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (items.length > 5000) return void res.status(413).json({ error: "too_large", message: "Max 5000 records per batch" });
  const accepted = [], rejected: { index: number; error: string }[] = [];
  for (const [i, it] of items.entries()) { const p = NifiRecord.safeParse(it); if (p.success) accepted.push(p.data); else rejected.push({ index: i, error: p.error.issues[0]?.message ?? "invalid" }); }
  const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await traces.insert(accepted.map((r) => {
    const end = r.timestamp ? new Date(typeof r.timestamp === "number" ? r.timestamp : Date.parse(r.timestamp)) : new Date();
    const failed = typeof r.status === "number" ? r.status >= 400 : !/^(ok|success|200)$/i.test(r.status);
    return {
      spanId: hex(8), traceId: r.trace_id?.padEnd(32, "0").slice(0, 32) ?? hex(16), parentSpanId: null, sessionId: r.session_id ?? null,
      name: r.kind === "llm" ? `chat ${r.model ?? "unknown"}` : `execute_tool ${r.tool ?? "unknown"}`, kind: r.kind, service: `nifi:${r.source}`,
      startTime: new Date(end.getTime() - r.latency_ms).toISOString(), durationMs: r.latency_ms, status: failed ? "error" as const : "ok" as const,
      attributes: { "gen_ai.system": r.provider ?? "unknown", "gen_ai.request.model": r.model, "gen_ai.tool.name": r.tool, "gen_ai.usage.input_tokens": r.input_tokens, "gen_ai.usage.output_tokens": r.output_tokens, "crucible.cost.usd": r.cost_usd ?? 0, "http.response.status_code": typeof r.status === "number" ? r.status : undefined, "crucible.request.preview": r.prompt?.slice(0, 400), "crucible.ingest": "nifi" },
      events: [],
    };
  }));
  await audit(`key:${req.apiKey!.name}`, "ingest.nifi", null, { accepted: accepted.length, rejected: rejected.length }, req.ip);
  res.status(rejected.length && !accepted.length ? 400 : 202).json({ accepted: accepted.length, rejected });
});

// ---- integrations, keys, audit ----
platformRouter.get("/api/integrations", viewer, async (_req, res) => {
  res.json({
    proxyBase: env.PUBLIC_URL, traceStore: traces.backend, queue: await queueStats(), judge: judgeMode(), judgeModel: judgeMode() === "claude" ? env.ANTHROPIC_MODEL : null,
    mongo: !!env.MONGO_URL, redis: !!env.REDIS_URL, upstreamKey: !!env.ANTHROPIC_API_KEY,
    keys: await q("SELECT id, name, preview, scopes, last_used_at, revoked_at, created_at FROM api_keys ORDER BY created_at DESC"),
  });
});
platformRouter.post("/api/keys", admin, async (req, res) => {
  const b = z.object({ name: z.string().min(2).max(60), scopes: z.array(z.enum(["proxy", "ci", "ingest"])).min(1).default(["proxy", "ci", "ingest"]) }).parse(req.body);
  const k = await createApiKey(b.name, req.user!.id, b.scopes);
  await audit(req.user!.email, "key.create", `key:${k.id}`, { name: b.name, scopes: b.scopes }, req.ip);
  res.status(201).json(k);
});
platformRouter.delete("/api/keys/:id", admin, async (req, res) => {
  await q("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [Number(req.params.id)]);
  await audit(req.user!.email, "key.revoke", `key:${req.params.id}`, {}, req.ip);
  res.json({ ok: true });
});
platformRouter.get("/api/audit", engineer, async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().max(500).default(200) }).parse(req.query);
  res.json(await q("SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1", [limit]));
});

// ---- realtime (SSE) ----
platformRouter.get("/api/stream", async (req, res) => {
  const user = await verify(String(req.query.ticket ?? ""), "stream");
  if (!user) return void res.status(401).json({ error: "unauthorized" });
  const traffic = req.query.traffic === "1";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": env.WEB_ORIGIN, "Access-Control-Allow-Credentials": "true" });
  res.write("retry: 3000\n\n");
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("ready", { user: user.name });
  const unsub = subscribe((e) => { if (e.type === "span" && !traffic) return; send(e.type, e); });
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => { clearInterval(ping); unsub(); });
});
