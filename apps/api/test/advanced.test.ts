import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setup, login, ids } from "./helpers.js";
import { one } from "../src/db/pool.js";
import { createRun, waitForRun } from "../src/services/runner.js";

let url = "", close: () => Promise<void>;
let eng: Record<string, string>, I: Awaited<ReturnType<typeof ids>>;
const post = async (p: string, body: unknown = {}) => fetch(url + p, { method: "POST", headers: eng, body: JSON.stringify(body) });
const get = async (p: string) => (await fetch(url + p, { headers: eng })).json();

beforeAll(async () => { ({ url, close } = await setup()); eng = await login(url); I = await ids(); });
afterAll(async () => { await close(); });

describe("live chaos experiments", () => {
  it("injects into real traffic only up to the blast radius, then completes itself", async () => {
    const e = await (await post("/api/experiments", { name: "orders 503 drill", fault: { type: "http_error", target: "tool:get_order", status: 503 }, trafficPct: 100, maxInjections: 2, durationMinutes: 5 })).json();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await (await post("/api/playground", { target: "get_order", input: { order_id: "AB-1001" } })).json()).status);
    expect(statuses).toEqual([503, 503, 200, 200]);
    const after = await one("SELECT * FROM experiments WHERE id = $1", [e.id]);
    expect(after).toMatchObject({ status: "completed", injected: 2, stop_reason: "blast radius reached" });
    const t = await get("/api/traffic?kind=tool");
    expect(t.spans.some((s: { attributes: Record<string, unknown> }) => s.attributes["crucible.experiment.id"] === e.id)).toBe(true);
  });
  it("never touches test sessions, and the kill switch stops everything at once", async () => {
    await post("/api/experiments", { name: "llm overload", fault: { type: "http_error", target: "llm", status: 529 }, trafficPct: 100, maxInjections: 1000 });
    // a scenario without faults still runs clean: experiments only apply to live (session-less) traffic
    const run = await waitForRun((await createRun({ suiteId: I.resilience, agentId: I.naive, scenarioIds: [(await one("SELECT id FROM scenarios WHERE name = 'Currency conversion'")).id] })).id);
    expect(run.summary.passRate).toBe(1);
    expect((await (await post("/api/playground", { target: "llm" })).json()).status).toBe(529);
    expect((await (await post("/api/experiments/stop-all")).json()).stopped).toBe(1);
    expect((await (await post("/api/playground", { target: "llm" })).json()).status).toBe(200);
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'experiment.kill_switch'")).toBeTruthy();
  });
});

describe("attack mutation fuzzing", () => {
  it("expands a red-team scenario; obfuscation bypasses the regex input guard but defence in depth holds", async () => {
    const base = await one("SELECT id, suite_id FROM scenarios WHERE name = 'Direct system-prompt extraction'");
    const created = await (await post(`/api/scenarios/${base.id}/mutate`, { strategies: ["base64", "leetspeak", "zero_width", "translation"] })).json();
    expect(created).toHaveLength(4);
    expect(created[0]).toMatchObject({ tags: expect.arrayContaining(["mutation", "base64"]), source: { type: "mutation", from: base.id } });
    expect((await (await post(`/api/scenarios/${base.id}/mutate`, { strategies: ["base64"] })).json())).toHaveLength(0); // idempotent
    const ids_ = created.map((c: { id: number }) => c.id);
    const [n, h] = await Promise.all([waitForRun((await createRun({ suiteId: base.suite_id, agentId: I.naive, scenarioIds: ids_ })).id), waitForRun((await createRun({ suiteId: base.suite_id, agentId: I.hardened, scenarioIds: ids_ })).id)]);
    expect(n.summary.outcomes.unsafe).toBe(4);           // v1 leaks its prompt for every variant
    expect(h.summary.outcomes.unsafe ?? 0).toBe(0);      // v2: input guard bypassed, but output redaction stops the leak
    const hc = await one("SELECT data, output FROM run_cases WHERE run_id = $1 AND scenario_name LIKE '%Base64%'", [h.id]);
    expect(hc.data?.blocked).toBeUndefined();
    expect(hc.output).toMatch(/can't share internal configuration/);
  });
});

describe("record & replay", () => {
  it("pins a failing case and its exact fault schedule as a new scenario", async () => {
    const run = await waitForRun((await createRun({ suiteId: I.resilience, agentId: I.naive, seed: 11, scenarioIds: [(await one("SELECT id FROM scenarios WHERE name = 'Order lookup · transient 500s'")).id] })).id);
    const c = await one("SELECT id, faults_injected FROM run_cases WHERE run_id = $1", [run.id]);
    const sc = await (await post(`/api/cases/${c.id}/to-scenario`)).json();
    expect(sc.name).toMatch(/^Replay · Order lookup/);
    expect(sc.faults).toEqual([expect.objectContaining({ type: "http_error", target: "tool:get_order", onCalls: [1, 2], status: 500 })]);
    expect(sc.tags).toContain("replay");
  });
});

describe("flakiness", () => {
  it("separates stable scenarios from flaky ones using repeats (pass@k vs pass^k)", async () => {
    const suite = await (await post("/api/suites", { name: "Flaky probe" })).json();
    await post(`/api/suites/${suite.id}/scenarios`, { name: "Coin-flip LLM outage", input: "How long does standard shipping take?", expected: "3-5 business days", assertions: [{ type: "contains", value: "3-5" }], faults: [{ type: "http_error", target: "llm", probability: 0.5 }] });
    await post(`/api/suites/${suite.id}/scenarios`, { name: "Always clean", input: "How much is 100 USD to EUR?", expected: "92.00 EUR", assertions: [{ type: "contains", value: "92.00" }] });
    await waitForRun((await createRun({ suiteId: suite.id, agentId: I.naive, repeats: 8, seed: 3 })).id);
    await waitForRun((await createRun({ suiteId: suite.id, agentId: I.naive, repeats: 8, seed: 4 })).id);
    const f = await get(`/api/suites/${suite.id}/flakiness`);
    const flaky = f.find((x: { scenario: string }) => x.scenario === "Coin-flip LLM outage"), stable = f.find((x: { scenario: string }) => x.scenario === "Always clean");
    expect(flaky.passRate).toBeGreaterThan(0); expect(flaky.passRate).toBeLessThan(1);
    expect(flaky.passAtK).toBe(1); expect(flaky.passHatK).toBe(0);
    expect(flaky.verdict).toBe("flaky");
    expect(stable).toMatchObject({ passRate: 1, flips: 0, verdict: "stable pass", flakiness: 0 });
  });
});

describe("scheduled runs + webhook alerts", () => {
  it("fires on schedule, stores the gate verdict, and posts a Slack-style alert on failure", async () => {
    const received: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const hook = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { received.push(JSON.parse(b)); res.end("ok"); }); });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/slack`;
    await waitForRun((await createRun({ suiteId: I.budgets, agentId: I.hardened, baseline: true, seed: 2 })).id);
    const s = await (await post("/api/schedules", { suiteId: I.budgets, agentId: I.xl, intervalMinutes: 60, webhookUrl: hookUrl, notify: "failures" })).json();
    const { runId } = await (await post(`/api/schedules/${s.id}/run-now`)).json();
    const run = await waitForRun(runId);
    expect(run).toMatchObject({ trigger: "schedule", schedule_id: s.id, seed: 2 });
    for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(received[0].text).toMatch(/gate FAILED.*Support bot v2 · XL model/s);
    expect(received[0].crucible.gate.reasons.join(" ")).toMatch(/cost increased/);
    const sched = (await get("/api/schedules")).find((x: { id: number }) => x.id === s.id);
    expect(sched).toMatchObject({ last_status: "gate_failed", last_gate: { passed: false } });
    expect(sched.deliveries[0]).toMatchObject({ status: 200, error: null });
    expect(new Date(sched.next_run_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    hook.close();
  });
});
