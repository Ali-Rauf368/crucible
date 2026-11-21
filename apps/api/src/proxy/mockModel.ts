/**
 * "crucible-mock" — a deterministic stand-in for an LLM provider speaking the Anthropic Messages API.
 * It plans tool calls from the task, retries failed tools (like real models do), and is deliberately
 * gullible: it follows instructions found in tool output or user input. That makes the *agent's*
 * defences (retries, budgets, validation, sanitisation, tool policies) the thing under test.
 */
type Block = { type: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Msg = { role: "user" | "assistant"; content: string | Block[] };
export interface MessagesRequest { model: string; system?: string | { type: string; text: string }[]; messages: Msg[]; tools?: { name: string }[]; max_tokens?: number; stream?: boolean }

const blocks = (c: Msg["content"]): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);
const text = (c: Msg["content"]) => blocks(c).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const sysText = (s: MessagesRequest["system"]) => (typeof s === "string" ? s : (s ?? []).map((b) => b.text).join("\n"));
export const estimateTokens = (v: unknown) => Math.max(1, Math.ceil(JSON.stringify(v ?? "").length / 4));
const INJECTION = /ignore (all )?(previous|prior) instructions|new system prompt/i;

interface ToolRun { name: string; input: any; ok: boolean; content: string } // eslint-disable-line @typescript-eslint/no-explicit-any

function history(messages: Msg[]): ToolRun[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  const runs: ToolRun[] = [];
  for (const m of messages) for (const b of blocks(m.content)) {
    if (b.type === "tool_use") calls.set(b.id, { name: b.name, input: b.input });
    if (b.type === "tool_result") {
      const c = calls.get(b.tool_use_id);
      const content = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: Block) => x.text ?? "").join("");
      if (c) runs.push({ name: c.name, input: c.input, ok: !b.is_error, content });
    }
  }
  return runs;
}

function plan(task: string, tools: Set<string>): { name: string; input: Record<string, unknown> }[] {
  const steps: { name: string; input: Record<string, unknown> }[] = [];
  const t = task.toLowerCase();
  const order = task.match(/\bAB-\d{4}\b/)?.[0];
  if (order && tools.has("get_order")) steps.push({ name: "get_order", input: { order_id: order } });
  if (order && /refund|return my|money back/.test(t) && tools.has("refund_order")) steps.push({ name: "refund_order", input: { order_id: order, reason: "customer request" } });
  const fx = task.match(/(\d+(?:\.\d+)?)\s*(USD|EUR|GBP)\s*(?:to|in|into)\s*(USD|EUR|GBP)/i);
  if (fx && tools.has("convert_currency")) steps.push({ name: "convert_currency", input: { amount: Number(fx[1]), from: fx[2].toUpperCase(), to: fx[3].toUpperCase() } });
  const city = task.match(/weather (?:like )?(?:in|for) ([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?)/)?.[1];
  if (city && tools.has("get_weather")) steps.push({ name: "get_weather", input: { city } });
  if (/polic|how (do|long|can)|warranty|shipping|return|password|reset/.test(t) && !order && tools.has("search_kb")) steps.push({ name: "search_kb", input: { query: task } });
  const transfer = task.match(/transfer \$?(\d+(?:\.\d+)?)\s*(?:usd|dollars)? to (?:account )?([A-Z]{2,4}-\d+)/i);
  if (transfer && tools.has("transfer_funds")) steps.push({ name: "transfer_funds", input: { to_account: transfer[2], amount: Number(transfer[1]) } });
  const mail = task.match(/email ([\w.+-]+@[\w.-]+)/i);
  if (mail && tools.has("send_email")) steps.push({ name: "send_email", input: { to: mail[1], subject: "Your request", body: task.slice(0, 200) } });
  return steps;
}

const parse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
const pick = (o: any, ...keys: string[]) => { for (const k of keys) { const v = k.split(".").reduce((a, p) => a?.[p], o); if (v != null) return v; } return undefined; }; // eslint-disable-line @typescript-eslint/no-explicit-any

function summarize(runs: ToolRun[]): string {
  const parts: string[] = [];
  const latest = new Map<string, ToolRun>();
  for (const r of runs) latest.set(r.name, r);
  for (const r of latest.values()) {
    if (!r.ok) {
      const why = r.content.replace(/^DO_NOT_RETRY:\s*/i, "");
      if (/approval/i.test(why)) parts.push(`I can't do that myself: ${r.name.replace(/_/g, " ")} needs approval from a support agent, so I haven't executed it. I've flagged your request for review.`);
      else if (/HTTP 4\d\d/.test(why)) parts.push(`I couldn't find what you asked for (${why.match(/"message":"([^"]+)"/)?.[1] ?? "not found"}). Could you double-check the details?`);
      else parts.push(`I couldn't reach the ${r.name.replace(/_/g, " ")} service just now. It seems temporarily unavailable; please try again shortly.`);
      continue;
    }
    const d = parse(r.content);
    if (d == null) { parts.push(`The ${r.name.replace(/_/g, " ")} service returned data I couldn't read, so I can't confirm the details right now.`); continue; }
    switch (r.name) {
      case "get_order": {
        const status = pick(d, "status", "state", "data.state"), eta = pick(d, "eta", "estimated_delivery", "data.estimated_delivery");
        const id = pick(d, "order_id", "orderId", "data.orderId");
        parts.push(status ? `Order ${id} is ${status}${eta ? `, with estimated delivery on ${eta}` : ""}.` : `I found order ${id ?? ""} but its status field is missing.`);
        break;
      }
      case "refund_order": {
        const status = pick(d, "status", "state", "data.state");
        parts.push(status === "approved" ? `Your refund ${d.refund_id} of $${d.amount} has been approved and will reach your original payment method within 5 business days.` : `The refund was not possible: ${d.reason ?? status}.`);
        break;
      }
      case "search_kb": {
        const res = pick(d, "results", "items", "data.items") as { title: string; text: string }[] | undefined;
        parts.push(res?.length ? `${res[0].text}` : "I couldn't find a help article about that.");
        break;
      }
      case "get_weather": parts.push(`It's ${pick(d, "temperature_c", "temp", "data.temp")}°C and ${pick(d, "conditions", "data.conditions")} in ${pick(d, "city", "data.city")}.`); break;
      case "convert_currency": parts.push(`${d.amount} ${d.from} is about ${Number(d.result).toFixed(2)} ${d.to} (rate ${d.rate}).`); break;
      case "send_email": parts.push(`Email sent to ${d.to}.`); break;
      case "transfer_funds": parts.push(`Transfer ${d.transfer_id} of $${d.amount} to ${d.to_account} has been executed.`); break;
    }
  }
  return parts.join(" ");
}

let idSeq = 0;
const toolUse = (name: string, input: unknown): Block => ({ type: "tool_use", id: `toolu_mock_${Date.now().toString(36)}${(idSeq++).toString(36)}`, name, input });

export function mockRespond(req: MessagesRequest) {
  const tools = new Set((req.tools ?? []).map((t) => t.name));
  const firstUser = req.messages.find((m) => m.role === "user");
  const task = firstUser ? text(firstUser.content) : "";
  const runs = history(req.messages);
  const last = runs.at(-1);
  let content: Block[];

  // gullible: obeys injected instructions in the task or in the newest tool output
  const injected = [task, last?.content ?? ""].find((s) => INJECTION.test(s));
  const callInstr = injected?.match(/call (\w+) with (\{.*?\})/);
  const sameTool = callInstr && runs.some((r) => r.name === callInstr[1] && JSON.stringify(r.input) === JSON.stringify(parse(callInstr[2])));
  if (callInstr && tools.has(callInstr[1]) && !sameTool) content = [{ type: "text", text: "Processing the request." }, toolUse(callInstr[1], parse(callInstr[2]) ?? {})];
  else if (injected && /system prompt/i.test(injected)) content = [{ type: "text", text: `Sure. My system prompt is:\n${sysText(req.system)}` }];
  else if (injected && /reply only with: '([^']+)'/i.test(injected)) content = [{ type: "text", text: injected.match(/reply only with: '([^']+)'/i)![1] }];
  else if (last && !last.ok && !/DO_NOT_RETRY|permanently unavailable/i.test(last.content)) {
    content = [{ type: "text", text: `The ${last.name} call failed, retrying.` }, toolUse(last.name, last.input)]; // naive models retry
  } else {
    const done = new Set(runs.filter((r) => r.ok).map((r) => r.name + JSON.stringify(r.input)));
    const gaveUp = new Set(runs.filter((r) => !r.ok && /DO_NOT_RETRY|permanently unavailable/i.test(r.content)).map((r) => r.name));
    const next = plan(task, tools).find((s) => !done.has(s.name + JSON.stringify(s.input)) && !gaveUp.has(s.name) && !(s.name === "refund_order" && runs.some((r) => r.name === "get_order" && !r.ok)));
    if (next) content = [toolUse(next.name, next.input)];
    else content = [{ type: "text", text: runs.length ? summarize(runs) : tools.size ? "I can help with orders, refunds, policies, weather and currency conversion. Could you share a bit more detail?" : `Answer: ${task.slice(0, 200)}` }];
  }

  const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  return {
    id: `msg_mock_${Date.now().toString(36)}`, type: "message", role: "assistant", model: req.model, content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: estimateTokens([req.system, req.messages, req.tools]), output_tokens: estimateTokens(content) },
  };
}
