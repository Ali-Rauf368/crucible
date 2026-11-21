import { TOOLS } from "../proxy/tools.js";
import { systemPrompt, type Agent } from "./contract.js";

/**
 * support-bot v1: the kind of agent that passes a demo. Raw fetch, no timeouts, no retries, trusts
 * every response, JSON.parse without guards, no step budget, no tool policy.
 */
export const naiveAgent: Agent = async ({ input, llmBaseUrl, toolsBaseUrl, headers, config, signal }) => {
  const slug = String(config.slug ?? "support-naive");
  const messages: any[] = [{ role: "user", content: input }]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const data: Record<string, unknown> = {};
  for (let step = 1; ; step++) {
    const r = await fetch(`${llmBaseUrl}/v1/messages`, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: config.model ?? "crucible-mock-1", max_tokens: 1024, system: systemPrompt(slug), tools: TOOLS, messages }) });
    const msg = JSON.parse(await r.text()); // throws on malformed bodies
    if (msg.type === "error") throw new Error(`LLM error: ${msg.error.type}: ${msg.error.message}`);
    messages.push({ role: "assistant", content: msg.content });
    const calls = msg.content.filter((b: { type: string }) => b.type === "tool_use");
    if (!calls.length) return { output: msg.content.map((b: { text?: string }) => b.text ?? "").join(""), data, steps: step };
    const results = [];
    for (const call of calls) {
      const tr = await fetch(`${toolsBaseUrl}/${call.name}`, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(call.input) });
      const body = await tr.text();
      const parsed = JSON.parse(body); // throws on malformed / empty bodies
      if (tr.ok && call.name === "get_order") Object.assign(data, { order_status: parsed.status, order_id: parsed.order_id });
      if (tr.ok && call.name === "refund_order") Object.assign(data, { refund_status: parsed.status });
      results.push({ type: "tool_result", tool_use_id: call.id, content: body, is_error: !tr.ok });
    }
    messages.push({ role: "user", content: results });
  }
};
