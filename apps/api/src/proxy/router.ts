import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { env } from "../lib/env.js";
import { verify, checkKey } from "../lib/auth.js";
import { startSpan, remoteParent, SpanStatusCode, SpanKind } from "../lib/tracing.js";
import { decide, chance, sleep, breakJson, driftSchema, INJECTIONS, FaultSpec, type Decision } from "../chaos/faults.js";
import { getSession, countCall, recordUsage, type Session } from "./session.js";
import { mockRespond, estimateTokens, type MessagesRequest } from "./mockModel.js";
import { runMockTool, ToolError, TOOLS, DANGEROUS } from "./tools.js";
import { costUsd } from "./pricing.js";
import type { Span } from "@opentelemetry/api";

/**
 * The interception layer. Agents point their LLM base URL at /proxy/anthropic and their tool calls at
 * /proxy/tools/:name, adding `x-crucible-key` and (during test runs) `x-crucible-session`.
 * Every call becomes an OTel span; in a session, the case's fault plan is applied deterministically.
 */
export const proxyRouter = Router();

/** Crucible auth for proxied calls: an internal service token (reference agents) or an API key with the proxy scope.
 *  Uses its own header so the agent's provider key (x-api-key) passes through untouched. */
async function proxyAuth(req: Request, res: Response, next: NextFunction) {
  const k = req.header("x-crucible-key");
  if (k && !k.startsWith("cr_") && (await verify(k, "internal"))) { res.locals.internal = true; return next(); }
  const key = await checkKey(k, "proxy");
  if (!key) { res.status(401).json(errorBody("authentication_error", "Crucible proxy: missing or invalid x-crucible-key")); return; }
  if (key === "forbidden") { res.status(403).json(errorBody("permission_error", "Crucible proxy: key lacks the proxy scope")); return; }
  next();
}

const errorBody = (type: string, message: string) => ({ type: "error", error: { type, message } });

/** Playground: a single fault forced on this call (x-crucible-fault, internal callers only). */
function adhocFault(req: Request, res: Response, span: Span): Decision | null {
  const raw = req.header("x-crucible-fault");
  if (!raw || !res.locals.internal) return null;
  const fault = FaultSpec.parse(JSON.parse(raw));
  span.setAttribute("crucible.fault.type", fault.type);
  span.addEvent("crucible.fault", { type: fault.type, target: fault.target, index: 0, adhoc: true });
  return { fault, index: 0 };
}

async function chaos(session: Session | null, kind: "llm" | "tool", span: Span, tool?: string, signature?: string, adhoc?: Decision | null) {
  if (adhoc) {
    if (adhoc.fault.type === "latency") await sleep((adhoc.fault.latencyMs ?? 2000) + (adhoc.fault.jitterMs ?? 0) * Math.random());
    return { terminal: adhoc.fault.type === "latency" ? null : adhoc, loop: false, callNumber: 1 };
  }
  if (!session) return { terminal: null as Decision | null, loop: false, callNumber: 0 };
  const c = await countCall(session, kind, tool, signature);
  span.setAttribute("crucible.call.number", c.callNumber);
  if (c.total > session.budget) {
    await recordUsage(session, { loop: true });
    span.addEvent("crucible.loop_guard", { total_calls: c.total, budget: session.budget });
    return { terminal: null, loop: true, callNumber: c.callNumber, guard: true };
  }
  if (signature && c.signatureCount >= 5) { await recordUsage(session, { loop: true }); span.setAttribute("crucible.loop.suspected", true); }
  if (!session.chaos) return { terminal: null, loop: false, callNumber: c.callNumber };
  const decisions = decide(session.faults, { kind, tool, callNumber: c.callNumber, toolCallNumber: c.toolCallNumber }, session.seed, session.sessionId, c.fired);
  for (const d of decisions) {
    const target = kind === "tool" ? `tool:${tool}` : "llm";
    await recordUsage(session, { fault: { index: d.index, type: d.fault.type, target, call: c.callNumber, at: new Date().toISOString() } });
    span.setAttribute("crucible.fault.type", d.fault.type);
    span.addEvent("crucible.fault", { type: d.fault.type, target, index: d.index });
    if (d.fault.type === "latency") {
      const jitter = Math.round((d.fault.jitterMs ?? 0) * chance(session.seed, session.sessionId, "jitter", c.callNumber));
      await sleep((d.fault.latencyMs ?? 2000) + jitter);
    }
  }
  return { terminal: decisions.find((d) => d.fault.type !== "latency") ?? null, loop: false, callNumber: c.callNumber };
}

/** Responses for faults that replace the upstream response entirely. */
async function failFast(fault: FaultSpec, kind: "llm" | "tool", req: Request, res: Response) {
  switch (fault.type) {
    case "http_error": {
      const status = fault.status ?? (kind === "llm" ? 529 : 500);
      res.status(status).json(kind === "llm" ? errorBody(status === 529 ? "overloaded_error" : "api_error", status === 529 ? "Overloaded" : "Internal server error") : { error: { message: `Upstream ${status}: internal error` } });
      return true;
    }
    case "rate_limit":
      res.status(429).setHeader("retry-after", "1");
      res.json(kind === "llm" ? errorBody("rate_limit_error", "Rate limit exceeded, retry after 1s") : { error: { message: "Too many requests" } });
      return true;
    case "timeout": {
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      await sleep(fault.latencyMs ?? 15_000, ac.signal);
      if (!res.headersSent && !ac.signal.aborted) res.status(504).json(kind === "llm" ? errorBody("timeout_error", "Gateway timeout") : { error: { message: "Gateway timeout" } });
      return true;
    }
    default: return false;
  }
}

// ---------------- LLM (Anthropic Messages API) ----------------
proxyRouter.post("/proxy/anthropic/v1/messages", proxyAuth, async (req, res) => {
  const body = req.body as MessagesRequest;
  const session = await getSession(req.header("x-crucible-session"));
  const parent = session?.traceId && session.rootSpanId ? remoteParent(session.traceId, session.rootSpanId) : undefined;
  const mock = String(body.model ?? "").startsWith("crucible-mock");
  const span = startSpan(`chat ${body.model}`, {
    "crucible.span.kind": "llm", "crucible.session.id": session?.sessionId, "gen_ai.system": mock ? "crucible-mock" : "anthropic", "gen_ai.operation.name": "chat",
    "gen_ai.request.model": body.model, "gen_ai.request.max_tokens": body.max_tokens, "crucible.request.messages": body.messages?.length, "crucible.request.tools": body.tools?.length ?? 0, "crucible.stream": !!body.stream,
    "crucible.request.preview": JSON.stringify(body.messages?.at(-1)?.content ?? "").slice(0, 400),
  }, parent, SpanKind.CLIENT);
  try {
    const c = await chaos(session, "llm", span, undefined, undefined, adhocFault(req, res, span));
    if ("guard" in c && c.guard) { span.setStatus({ code: SpanStatusCode.ERROR, message: "loop guard" }); res.status(429).json(errorBody("crucible_loop_guard", `Crucible stopped this session after ${session!.budget} calls (runaway loop).`)); return; }
    const fault = c.terminal?.fault;
    if (fault && (await failFast(fault, "llm", req, res))) { span.setStatus({ code: SpanStatusCode.ERROR, message: fault.type }); span.setAttribute("http.response.status_code", res.statusCode); return; }

    // produce the real response (mock or upstream)
    let message: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (mock) message = mockRespond(body);
    else {
      const key = (req.header("x-api-key") as string | undefined) ?? env.ANTHROPIC_API_KEY;
      if (!key) { span.setStatus({ code: SpanStatusCode.ERROR }); res.status(400).json(errorBody("invalid_request_error", "No upstream API key: pass x-api-key or set ANTHROPIC_API_KEY on Crucible")); return; }
      const upstream = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST", body: JSON.stringify(fault?.type === "truncated" ? { ...body, stream: false } : body),
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": req.header("anthropic-version") ?? "2023-06-01", ...(req.header("anthropic-beta") ? { "anthropic-beta": req.header("anthropic-beta")! } : {}) },
      });
      span.setAttribute("http.response.status_code", upstream.status);
      if (body.stream && upstream.ok && !fault) {
        // passthrough streaming; usage is parsed from the stream as it goes by
        res.status(upstream.status).setHeader("content-type", "text/event-stream");
        let usageIn = 0, usageOut = 0, buf = "";
        const reader = upstream.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          buf += Buffer.from(value).toString();
          for (const m of buf.matchAll(/"input_tokens":(\d+)/g)) usageIn = Number(m[1]);
          for (const m of buf.matchAll(/"output_tokens":(\d+)/g)) usageOut = Number(m[1]);
          buf = buf.slice(-2000);
        }
        res.end();
        await finishLlm(span, session, body.model, usageIn, usageOut, "stream");
        return;
      }
      message = await upstream.json();
      if (!upstream.ok) { span.setStatus({ code: SpanStatusCode.ERROR, message: message?.error?.type }); res.status(upstream.status).json(message); return; }
    }

    if (fault?.type === "truncated") {
      const txt = (message.content as { type: string; text?: string }[]).map((b) => b.text ?? (b.type === "tool_use" ? `I'll call a tool to check` : "")).join(" ");
      message = { ...message, content: [{ type: "text", text: txt.slice(0, Math.max(8, Math.floor(txt.length / 2))) }], stop_reason: "max_tokens", usage: { ...message.usage, output_tokens: body.max_tokens ?? message.usage.output_tokens } };
    }
    if (fault?.type === "empty_response") message = { ...message, content: [], stop_reason: "end_turn", usage: { ...message.usage, output_tokens: 0 } };
    await finishLlm(span, session, body.model, message.usage?.input_tokens ?? estimateTokens(body), message.usage?.output_tokens ?? 0, message.stop_reason);

    if (body.stream) return streamMock(message, res, fault?.type === "truncated");
    if (fault?.type === "malformed_json") { span.setStatus({ code: SpanStatusCode.ERROR, message: "malformed_json" }); res.status(200).type("application/json").send(breakJson(JSON.stringify(message), session?.seed ?? 1)); return; }
    res.json(message);
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
    if (!res.headersSent) res.status(502).json(errorBody("api_error", `Crucible proxy: ${(e as Error).message}`));
  } finally { span.end(); }
});

async function finishLlm(span: Span, session: Session | null, model: string, tin: number, tout: number, stop: string) {
  const cost = costUsd(model, tin, tout);
  span.setAttributes({ "gen_ai.usage.input_tokens": tin, "gen_ai.usage.output_tokens": tout, "gen_ai.response.finish_reasons": stop ?? "unknown", "crucible.cost.usd": cost.usd, "crucible.cost.priced": cost.priced });
  if (session) await recordUsage(session, { tokensIn: tin, tokensOut: tout, cost: cost.usd });
}

/** Re-emits a complete message as Anthropic-style SSE; `cut` drops the stream before message_stop. */
function streamMock(message: any, res: Response, cut: boolean) { // eslint-disable-line @typescript-eslint/no-explicit-any
  res.status(200).setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } });
  message.content.forEach((b: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    send("content_block_start", { type: "content_block_start", index: i, content_block: b.type === "text" ? { type: "text", text: "" } : { ...b, input: {} } });
    if (b.type === "text") for (const chunk of b.text.match(/.{1,24}/gs) ?? []) send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: chunk } });
    else send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    send("content_block_stop", { type: "content_block_stop", index: i });
  });
  if (cut) { res.end(); return; }
  send("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// ---------------- Tools ----------------
proxyRouter.get("/proxy/tools", (_req, res) => { res.json(TOOLS); });
proxyRouter.post("/proxy/tools/:name", proxyAuth, async (req, res) => {
  const name = String(req.params.name);
  const input = (req.body ?? {}) as Record<string, unknown>;
  const session = await getSession(req.header("x-crucible-session"));
  const parent = session?.traceId && session.rootSpanId ? remoteParent(session.traceId, session.rootSpanId) : undefined;
  const signature = crypto.createHash("sha1").update(name + JSON.stringify(input)).digest("hex").slice(0, 12);
  const span = startSpan(`execute_tool ${name}`, {
    "crucible.span.kind": "tool", "crucible.session.id": session?.sessionId, "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name,
    "crucible.tool.input": JSON.stringify(input).slice(0, 1000), "crucible.tool.dangerous": DANGEROUS.has(name),
  }, parent, SpanKind.CLIENT);
  try {
    const c = await chaos(session, "tool", span, name, signature, adhocFault(req, res, span));
    if ("guard" in c && c.guard) { span.setStatus({ code: SpanStatusCode.ERROR, message: "loop guard" }); res.status(429).json({ error: { type: "crucible_loop_guard", message: "Runaway loop stopped by Crucible" } }); return; }
    if (DANGEROUS.has(name) && session) { await recordUsage(session, { unsafe: { tool: name, input } }); span.addEvent("crucible.unsafe_action", { tool: name }); }
    const fault = c.terminal?.fault;
    if (fault && (await failFast(fault, "tool", req, res))) { span.setStatus({ code: SpanStatusCode.ERROR, message: fault.type }); span.setAttribute("http.response.status_code", res.statusCode); return; }

    let result: unknown;
    const upstream = req.header("x-crucible-upstream");
    if (upstream) {
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const txt = await r.text();
      if (!r.ok) { span.setStatus({ code: SpanStatusCode.ERROR }); res.status(r.status).type(r.headers.get("content-type") ?? "text/plain").send(txt); return; }
      try { result = JSON.parse(txt); } catch { result = txt; }
    } else {
      try { result = runMockTool(name, input); }
      catch (e) {
        const status = e instanceof ToolError ? e.status : 500;
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message }); span.setAttribute("http.response.status_code", status);
        res.status(status).json({ error: { message: (e as Error).message } }); return;
      }
    }

    switch (fault?.type) {
      case "schema_drift": result = driftSchema(result); break;
      case "prompt_injection": {
        const payload = INJECTIONS[fault.payload ?? "dangerous_action"];
        const r = result as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (Array.isArray(r?.results) && r.results[0]) r.results[0].text += `\n\n${payload}`;
        else result = { ...(typeof r === "object" ? r : { value: r }), notes: payload };
        break;
      }
      case "empty_response": span.setAttribute("http.response.status_code", 200); res.status(200).type("application/json").send(""); return;
      case "malformed_json": span.setStatus({ code: SpanStatusCode.ERROR, message: "malformed_json" }); res.status(200).type("application/json").send(breakJson(JSON.stringify(result), session?.seed ?? 1)); return;
      case "truncated": break;
    }
    span.setAttributes({ "http.response.status_code": 200, "crucible.tool.output": JSON.stringify(result).slice(0, 1000) });
    res.json(result);
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
    if (!res.headersSent) res.status(502).json({ error: { message: `Crucible proxy: ${(e as Error).message}` } });
  } finally { span.end(); }
});
