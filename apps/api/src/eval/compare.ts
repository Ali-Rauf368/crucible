import { chance } from "../chaos/faults.js";

/**
 * Regression analysis between a baseline run and a candidate run of the same suite.
 * Matches cases by scenario (+ attempt), reports metric deltas with a bootstrap 90% CI on the
 * pass-rate delta, lists flips, and applies the suite's gate.
 */
interface C { scenario_id: number | null; scenario_name: string; attempt: number; passed: boolean | null; critical: boolean; outcome: string | null; scores: { overall: number } | null; cost_usd: number; latency_ms: number | null }
interface R { id: number; label: string; scores: Record<string, number> | null; summary: any } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Thresholds { overall: number; maxRegression: number; maxCostIncreasePct: number }

export function compare(base: R, cand: R, baseCases: C[], candCases: C[], t: Thresholds) {
  const key = (c: C) => `${c.scenario_id ?? c.scenario_name}#${c.attempt}`;
  const bMap = new Map(baseCases.map((c) => [key(c), c]));
  const pairs = candCases.filter((c) => bMap.has(key(c))).map((c) => ({ b: bMap.get(key(c))!, c }));
  const flips = pairs.filter(({ b, c }) => b.passed !== c.passed).map(({ b, c }) => ({
    scenario: c.scenario_name, attempt: c.attempt, critical: c.critical, from: b.passed ? "pass" : "fail", to: c.passed ? "pass" : "fail",
    outcomeFrom: b.outcome, outcomeTo: c.outcome, overallFrom: b.scores?.overall ?? 0, overallTo: c.scores?.overall ?? 0,
  }));
  const regressions = flips.filter((f) => f.to === "fail"), fixes = flips.filter((f) => f.to === "pass");

  // paired bootstrap on pass-rate delta (deterministic)
  const diffs = pairs.map(({ b, c }) => (c.passed ? 1 : 0) - (b.passed ? 1 : 0));
  const boots: number[] = [];
  for (let i = 0; i < 1000 && diffs.length; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(chance("boot", base.id, cand.id, i, j) * diffs.length)];
    boots.push(s / diffs.length);
  }
  boots.sort((a, b) => a - b);
  const passDelta = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  const ci = boots.length ? [boots[Math.floor(0.05 * boots.length)], boots[Math.floor(0.95 * boots.length) - 1]] : [0, 0];

  const delta = (k: string) => Math.round(((cand.scores?.[k] ?? 0) - (base.scores?.[k] ?? 0)) * 1000) / 1000;
  const bc = base.summary?.costUsd ?? 0, cc = cand.summary?.costUsd ?? 0;
  const costPct = bc > 0 ? Math.round(((cc - bc) / bc) * 1000) / 10 : 0;
  const latPct = base.summary?.latency?.p95 ? Math.round(((cand.summary.latency.p95 - base.summary.latency.p95) / base.summary.latency.p95) * 1000) / 10 : 0;

  const reasons: string[] = [];
  const crit = regressions.filter((r) => r.critical);
  if (crit.length) reasons.push(`${crit.length} critical scenario(s) regressed: ${crit.map((r) => r.scenario).slice(0, 5).join(", ")}`);
  if (delta("overall") < -t.maxRegression) reasons.push(`overall score dropped ${Math.abs(delta("overall")).toFixed(3)} (budget ${t.maxRegression})`);
  if (costPct > t.maxCostIncreasePct) reasons.push(`cost increased ${costPct}% (budget ${t.maxCostIncreasePct}%)`);
  if ((cand.scores?.overall ?? 0) < t.overall) reasons.push(`overall ${cand.scores?.overall ?? 0} below suite threshold ${t.overall}`);

  return {
    baseline: { id: base.id, label: base.label, scores: base.scores, summary: base.summary },
    candidate: { id: cand.id, label: cand.label, scores: cand.scores, summary: cand.summary },
    deltas: { accuracy: delta("accuracy"), safety: delta("safety"), resilience: delta("resilience"), overall: delta("overall"), passRate: Math.round(passDelta * 1000) / 1000, passRateCI90: ci.map((x) => Math.round(x * 1000) / 1000), costPct, latencyP95Pct: latPct },
    matched: pairs.length, regressions, fixes,
    gate: { passed: reasons.length === 0, reasons, thresholds: t },
  };
}
