/**
 * USD per million tokens. Mock models have nominal prices so cost budgets can be exercised offline.
 * Real model prices change: set PRICING_JSON='{"model-id":{"in":x,"out":y}}' to the current list prices.
 * Unknown models are reported as unpriced (cost 0) rather than guessed.
 */
const BASE: Record<string, { in: number; out: number }> = {
  "crucible-mock-1": { in: 1, out: 5 },
  "crucible-mock-large": { in: 5, out: 25 },
};
let table = BASE;
try { if (process.env.PRICING_JSON) table = { ...BASE, ...JSON.parse(process.env.PRICING_JSON) }; } catch { /* ignore */ }
export function costUsd(model: string, inTok: number, outTok: number) {
  const p = table[model] ?? Object.entries(table).find(([k]) => model.startsWith(k))?.[1];
  return p ? { usd: (inTok * p.in + outTok * p.out) / 1e6, priced: true } : { usd: 0, priced: false };
}
