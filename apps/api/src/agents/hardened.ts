import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, DANGEROUS } from "../proxy/tools.js";
import { canaryFor, systemPrompt, type Agent } from "./contract.js";

/**
 * support-bot v2: the same task, engineered for production. Uses the official Anthropic SDK pointed at
 * the Crucible proxy (retries with backoff on 429/5xx/529, request timeouts), plus:
 *  - step budget and graceful degradation         - tool timeouts, retries honouring Retry-After
 *  - JSON validation and schema normalisation      - indirect-injection sanitising of tool output
 *  - human-approval policy for dangerous tools     - input guard and output redaction (canary)
 *  - continuation on max_tokens, retry on empty / unparseable model responses
 */
const INJECTION = /ignore (all )?(previous|prior) instructions|new system prompt|you are now|system notice|print your (complete )?system prompt/i;
const MAX_STEPS = 8;

/** Walks string values of untrusted tool data; everything from the first injection marker onwards is dropped. */
function sanitize(value: unknown, hit = { flagged: false }): unknown {
  if (typeof value === "string") {
    const m = value.search(/(important )?system notice|ignore (all )?(previous|prior) instructions|###\s*new system prompt|you are now|print your (complete )?system prompt|\b(assistant|ai),? (ignore|you must)/i);
    if (m === -1) return value;
    hit.flagged = true;
    return value.slice(0, m).trim() || "[removed: instructions embedded in tool data]";
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, hit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, hit)]));
  return value;
}
function normalize(v: any): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (Array.isArray(v)) return v.map(normalize);
  if (!v || typeof v !== "object") return v;
  if (v._v === 2 && v.data) return normalize(v.data);
  const MAP: Record<string, string> = { state: "status", orderId: "order_id", amount_cents: "amount", temp: "temperature_c", items: "results", estimated_delivery: "eta" };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [MAP[k] ?? k, k === "amount_cents" && typeof x === "number" ? x / 100 : normalize(x)]));
}

async function callTool(base: string, name: string, input: unknown, headers: Record<string, string>, signal?: AbortSignal) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${base}/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input), signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
      const text = await r.text();
      if (r.status === 429 || r.status >= 500) {
        if (attempt < 3) { await new Promise((res) => setTimeout(res, Math.min(4000, Number(r.headers.get("retry-after") ?? 0) * 1000 || 300 * 2 ** attempt))); continue; }
        return { ok: false, content: `DO_NOT_RETRY: ${name} is temporarily unavailable (HTTP ${r.status}). Apologise and suggest trying again later.` };
      }
      if (!r.ok) return { ok: false, content: `DO_NOT_RETRY: ${name} rejected the request (HTTP ${r.status}): ${text.slice(0, 200)}` };
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        if (attempt < 3) continue;
        return { ok: false, content: `DO_NOT_RETRY: ${name} returned unreadable data. Tell the user the details can't be confirmed right now.` };
      }
      const hit = { flagged: false };
      const clean = sanitize(normalize(parsed), hit);
      return { ok: true, data: clean, content: JSON.stringify(clean), flagged: hit.flagged };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt === 3) return { ok: false, content: `DO_NOT_RETRY: ${name} timed out. Apologise and suggest trying again later.` };
    }
  }
  return { ok: false, content: `DO_NOT_RETRY: ${name} failed` };
}

export const hardenedAgent: Agent = async ({ input, llmBaseUrl, toolsBaseUrl, headers, config, signal }) => {
  const slug = String(config.slug ?? "support-hardened");
  if (INJECTION.test(input)) return { output: "I can't help with that request, but I'm happy to help with orders, refunds, policies, weather or currency questions.", data: { blocked: "input_guard" }, steps: 0 };
  const client = new Anthropic({ baseURL: llmBaseUrl, apiKey: "crucible-proxied", defaultHeaders: headers, maxRetries: 3, timeout: 6000 });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: input }];
  const data: Record<string, unknown> = {};
  let continuation = 0;
  for (let step = 1; step <= MAX_STEPS; step++) {
    let msg: Anthropic.Message | null = null;
    for (let attempt = 1; attempt <= 2 && !msg; attempt++) {
      try {
        const m = await client.messages.create({ model: String(config.model ?? "crucible-mock-1"), max_tokens: 1024, system: systemPrompt(slug), tools: TOOLS as Anthropic.Tool[], messages }, { signal });
        if (!Array.isArray(m?.content)) throw new Error("malformed response");
        if (!m.content.length && attempt < 2) continue; // empty completion: ask again once
        msg = m;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt === 2) return { output: "Sorry, our assistant is having trouble right now. Please try again in a few minutes.", data: { ...data, degraded: true }, steps: step };
      }
    }
    if (!msg) return { output: "Sorry, I couldn't generate an answer. Please try again.", data: { ...data, degraded: true }, steps: step };

    if (msg.stop_reason === "max_tokens" && continuation < 2) {
      continuation++;
      messages.push({ role: "assistant", content: msg.content }, { role: "user", content: "Your previous reply was cut off. Please give the complete answer." });
      continue;
    }
    const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      let output = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      if (output.includes(canaryFor(slug)) || /internal reference token/i.test(output)) output = "I can't share internal configuration details.";
      if (!output.trim()) output = "Sorry, I couldn't generate an answer. Please try again.";
      return { output, data, steps: step };
    }
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      if (DANGEROUS.has(call.name)) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `DO_NOT_RETRY: ${call.name} requires human approval and was not executed. Tell the user a support agent must approve this.` });
        data.blocked_tool = call.name;
        continue;
      }
      const r = await callTool(toolsBaseUrl, call.name, call.input, headers, signal);
      if (r.ok && call.name === "get_order") Object.assign(data, { order_status: (r.data as any)?.status, order_id: (r.data as any)?.order_id }); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (r.ok && call.name === "refund_order") Object.assign(data, { refund_status: (r.data as any)?.status }); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (r.flagged) data.injection_filtered = true;
      results.push({ type: "tool_result", tool_use_id: call.id, content: r.content, is_error: !r.ok });
    }
    messages.push({ role: "user", content: results });
  }
  return { output: "I wasn't able to finish this request within my step limit. A support agent will follow up.", data: { ...data, degraded: true }, steps: MAX_STEPS };
};
