#!/usr/bin/env node
// Crucible CI gate: runs a suite against an agent, compares it with the suite baseline (same seed, so the
// same fault schedule) and exits non-zero when the regression gate fails.
//
//   CRUCIBLE_URL=http://crucible:4200 CRUCIBLE_KEY=cr_... \
//     node scripts/crucible-ci.mjs --suite support-resilience --agent support-hardened [--label "prompt v14"] [--repeats 3]
//
// Exit codes: 0 gate passed · 1 gate failed · 2 usage / Crucible error.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = process.env.CRUCIBLE_URL ?? "http://127.0.0.1:4200";
const key = process.env.CRUCIBLE_KEY;
if (!key || !args.suite || !args.agent) {
  console.error("usage: CRUCIBLE_KEY=... node scripts/crucible-ci.mjs --suite <slug> --agent <slug> [--label text] [--repeats n]");
  process.exit(2);
}
const sha = process.env.GIT_SHA ?? process.env.GITHUB_SHA;
const pct = (v) => (v == null ? "-" : `${Math.round(v * 100)}%`);

console.log(`> Crucible: ${args.suite} x ${args.agent}${sha ? ` @ ${sha.slice(0, 7)}` : ""}`);
const res = await fetch(`${url}/api/ci/runs`, {
  method: "POST",
  headers: { "x-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({ suite: args.suite, agent: args.agent, label: args.label, gitSha: sha, repeats: args.repeats ? Number(args.repeats) : undefined }),
});
const body = await res.json().catch(() => ({}));
if (res.status !== 200 && res.status !== 422) {
  console.error(`x Crucible error ${res.status}: ${body.message ?? JSON.stringify(body)}`);
  process.exit(2);
}

console.log(`  run #${body.runId}: overall ${pct(body.scores?.overall)} | pass ${pct(body.summary?.passRate)} | safety ${pct(body.scores?.safety)} | resilience ${pct(body.scores?.resilience)} | cost $${(body.summary?.costUsd ?? 0).toFixed(4)}`);
if (body.deltas) console.log(`  vs baseline #${body.baselineRunId}: overall ${body.deltas.overall >= 0 ? "+" : ""}${(body.deltas.overall * 100).toFixed(1)} pts | cost ${body.deltas.costPct >= 0 ? "+" : ""}${body.deltas.costPct}%`);
for (const r of body.regressions ?? []) console.log(`  regression: ${r.scenario}${r.critical ? " [critical]" : ""}: ${r.outcomeFrom} -> ${r.outcomeTo}`);
if (body.reportUrl) console.log(`  report: ${process.env.CRUCIBLE_WEB_URL ?? url.replace(/:4200$/, ":3200")}${body.reportUrl}`);

if (body.gate?.passed) { console.log("OK gate passed"); process.exit(0); }
console.error(`FAIL gate failed:\n${(body.gate?.reasons ?? []).map((r) => `  - ${r}`).join("\n")}`);
process.exit(1);
