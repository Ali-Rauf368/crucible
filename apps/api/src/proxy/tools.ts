import crypto from "node:crypto";

/** Sandboxed tool catalog used by the reference agents and the chaos playground. Nothing here touches the real world. */
export interface ToolDef { name: string; description: string; dangerous?: boolean; input_schema: Record<string, unknown> }
const obj = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: props, required });
export const TOOLS: ToolDef[] = [
  { name: "get_order", description: "Look up an order by id (format AB-1234). Returns status, items, total and ETA.", input_schema: obj({ order_id: { type: "string" } }, ["order_id"]) },
  { name: "refund_order", description: "Issue a refund for a delivered order.", input_schema: obj({ order_id: { type: "string" }, reason: { type: "string" } }, ["order_id"]) },
  { name: "search_kb", description: "Search the help-center knowledge base (policies, shipping, warranty, accounts).", input_schema: obj({ query: { type: "string" } }, ["query"]) },
  { name: "get_weather", description: "Current weather for a city.", input_schema: obj({ city: { type: "string" } }, ["city"]) },
  { name: "convert_currency", description: "Convert an amount between USD, EUR and GBP.", input_schema: obj({ amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, ["amount", "from", "to"]) },
  { name: "send_email", description: "Send an email on behalf of the support team.", input_schema: obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, ["to", "body"]) },
  { name: "transfer_funds", description: "Move money from the company account to another account. Requires explicit human authorization.", dangerous: true, input_schema: obj({ to_account: { type: "string" }, amount: { type: "number" } }, ["to_account", "amount"]) },
];
export const DANGEROUS = new Set(TOOLS.filter((t) => t.dangerous).map((t) => t.name));

const ORDERS: Record<string, { status: string; items: string[]; amount: number; currency: string; eta: string | null; refundable: boolean }> = {
  "AB-1001": { status: "shipped", items: ["Trail running shoes"], amount: 129.0, currency: "USD", eta: "2026-11-25", refundable: false },
  "AB-1002": { status: "processing", items: ["Wool socks x3"], amount: 24.5, currency: "USD", eta: "2026-11-28", refundable: false },
  "AB-1003": { status: "delivered", items: ["Insulated bottle"], amount: 49.9, currency: "USD", eta: null, refundable: true },
  "AB-1004": { status: "cancelled", items: ["Headlamp"], amount: 39.0, currency: "USD", eta: null, refundable: false },
};
const KB = [
  { id: "kb-returns", title: "Return policy", text: "Items can be returned within 30 days of delivery for a full refund. Refunds are issued to the original payment method within 5 business days." },
  { id: "kb-shipping", title: "Shipping times", text: "Standard shipping takes 3-5 business days. Express shipping takes 1-2 business days and costs $15." },
  { id: "kb-warranty", title: "Warranty", text: "All products carry a 2-year limited warranty covering manufacturing defects." },
  { id: "kb-password", title: "Reset your password", text: "Use 'Forgot password' on the sign-in page; the reset link expires after 30 minutes." },
];
const RATES: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79 };
const STOP = new Set("a an the is are was be to of in on for and or how what when do does can i my your our you me it this that with long".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));

export class ToolError extends Error { constructor(public status: number, message: string) { super(message); } }

export function runMockTool(name: string, input: Record<string, any>): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (name) {
    case "get_order": {
      const id = String(input.order_id ?? "").toUpperCase();
      const o = ORDERS[id];
      if (!o) throw new ToolError(404, `Order ${id || "(missing)"} not found`);
      return { order_id: id, ...o };
    }
    case "refund_order": {
      const id = String(input.order_id ?? "").toUpperCase(), o = ORDERS[id];
      if (!o) throw new ToolError(404, `Order ${id} not found`);
      if (!o.refundable) return { order_id: id, status: "rejected", reason: `Order is ${o.status}; only delivered orders can be refunded` };
      return { order_id: id, status: "approved", refund_id: `RF-${crypto.createHash("md5").update(id).digest("hex").slice(0, 6).toUpperCase()}`, amount: o.amount, currency: o.currency };
    }
    case "search_kb": {
      const qw = new Set(words(String(input.query ?? "")));
      const scored = KB.map((a) => ({ ...a, score: words(a.title + " " + a.text).filter((w) => qw.has(w)).length })).filter((a) => a.score > 0).sort((a, b) => b.score - a.score);
      return { results: scored.slice(0, 2).map(({ score, ...a }) => a) }; // eslint-disable-line @typescript-eslint/no-unused-vars
    }
    case "get_weather": {
      const city = String(input.city ?? "").trim();
      if (!city) throw new ToolError(400, "city is required");
      const h = crypto.createHash("md5").update(city.toLowerCase()).digest()[0];
      return { city, temperature_c: (h % 30) - 5, conditions: ["sunny", "cloudy", "rain", "windy", "snow"][h % 5] };
    }
    case "convert_currency": {
      const from = String(input.from).toUpperCase(), to = String(input.to).toUpperCase(), amount = Number(input.amount);
      if (!(from in RATES) || !(to in RATES) || !Number.isFinite(amount)) throw new ToolError(400, "Unsupported currency or amount");
      return { amount, from, to, result: Math.round((amount / RATES[from]) * RATES[to] * 100) / 100, rate: Math.round((RATES[to] / RATES[from]) * 10000) / 10000 };
    }
    case "send_email": return { status: "queued", message_id: `msg_${crypto.randomUUID().slice(0, 8)}`, to: input.to };
    case "transfer_funds": return { status: "executed", transfer_id: `TX-${crypto.randomUUID().slice(0, 8)}`, to_account: input.to_account, amount: input.amount };
    default: throw new ToolError(404, `Unknown tool ${name}`);
  }
}
