"use client";
import { useEffect, useState } from "react";
import { Plus, Trash2, Zap, ListChecks } from "lucide-react";
import { useApi } from "@/lib/api";
import { Modal, Spinner, cx } from "./ui";
import { FAULT_COLORS } from "./domain";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ScenarioDraft { id?: number; name: string; category: string; input: string; expected: string; critical: boolean; enabled: boolean; tags: string[]; faults: Json[]; assertions: Json[] }
export const EMPTY: ScenarioDraft = { name: "", category: "functional", input: "", expected: "", critical: false, enabled: true, tags: [], faults: [], assertions: [{ type: "contains", value: "" }] };
const NEEDS_VALUE = new Set(["contains", "not_contains", "regex", "not_regex", "tool_called", "tool_not_called", "max_latency_ms", "max_cost_usd", "max_tokens", "max_llm_calls", "judge_min", "data_equals", "json_schema"]);

export function ScenarioEditor({ draft, onClose, onSave }: { draft: ScenarioDraft | null; onClose: () => void; onSave: (d: ScenarioDraft) => Promise<void> }) {
  const catalog = useApi<Json>(draft ? "/api/catalog" : null);
  const [d, setD] = useState<ScenarioDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (draft) { setD(JSON.parse(JSON.stringify(draft))); setErr(""); } }, [draft]);
  const tools: string[] = catalog.data?.tools.map((t: Json) => t.name) ?? [];
  const setFault = (i: number, patch: Json) => setD({ ...d, faults: d.faults.map((f, j) => (j === i ? clean({ ...f, ...patch }) : f)) });
  const setAssert = (i: number, patch: Json) => setD({ ...d, assertions: d.assertions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try {
      const assertions = d.assertions.map((a) => {
        const out: Json = { type: a.type, ...(a.critical ? { critical: true } : {}), ...(a.path ? { path: a.path } : {}) };
        if (!NEEDS_VALUE.has(a.type)) return out;
        const raw = typeof a.value === "string" ? a.value : JSON.stringify(a.value);
        if (a.type === "json_schema") out.value = JSON.parse(raw || "{}");
        else if (a.type === "data_equals") { try { out.value = JSON.parse(raw); } catch { out.value = raw; } }
        else if (["max_latency_ms", "max_cost_usd", "max_tokens", "max_llm_calls", "judge_min"].includes(a.type)) out.value = Number(raw);
        else if (["contains", "not_contains"].includes(a.type) && raw.includes("|")) out.value = raw.split("|").map((x: string) => x.trim()).filter(Boolean);
        else out.value = raw;
        return out;
      });
      setBusy(true);
      await onSave({ ...d, assertions });
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={!!draft} onClose={onClose} title={d.id ? "Edit scenario" : "New scenario"} wide>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className="block"><span className="label">Name</span><input className="input" required minLength={3} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
          <label className="block"><span className="label">Category</span><input className="input" list="cats" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} /><datalist id="cats">{["functional", "tool-failure", "llm-failure", "latency", "data-quality", "prompt-injection", "jailbreak", "excessive-agency", "budget"].map((c) => <option key={c} value={c} />)}</datalist></label>
        </div>
        <label className="block"><span className="label">User input</span><textarea className="input min-h-20" required value={d.input} onChange={(e) => setD({ ...d, input: e.target.value })} /></label>
        <label className="block"><span className="label">Reference answer (for the judge)</span><textarea className="input min-h-16" value={d.expected} onChange={(e) => setD({ ...d, expected: e.target.value })} /></label>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.critical} onChange={(e) => setD({ ...d, critical: e.target.checked })} />Critical (a regression here always fails the gate)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />Enabled</label>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between"><h3 className="flex items-center gap-1.5 text-sm font-semibold"><Zap className="h-4 w-4 text-accent" />Fault plan</h3><button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setD({ ...d, faults: [...d.faults, { type: "http_error", target: "llm", onCalls: [1] }] })}><Plus className="h-3.5 w-3.5" />Add fault</button></div>
          {!d.faults.length && <p className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">No faults: this scenario runs clean (functional check).</p>}
          <ul className="space-y-2">{d.faults.map((f, i) => (
            <li key={i} className="grid gap-2 rounded-lg border border-line bg-raised/40 p-3 sm:grid-cols-12">
              <label className="sm:col-span-3"><span className="label">Fault</span><select className="input" value={f.type} onChange={(e) => setFault(i, { type: e.target.value })} style={{ borderLeft: `3px solid ${FAULT_COLORS[f.type]}` }}>{catalog.data?.faults.map((x: Json) => <option key={x.type} value={x.type}>{x.label}</option>)}</select></label>
              <label className="sm:col-span-3"><span className="label">Target</span><select className="input" value={f.target} onChange={(e) => setFault(i, { target: e.target.value })}><option value="llm">LLM calls</option><option value="tool">All tools</option>{tools.map((t) => <option key={t} value={`tool:${t}`}>tool: {t}</option>)}</select></label>
              <label className="sm:col-span-2"><span className="label">Fires on</span><select className="input" value={f.onCalls ? "calls" : "prob"} onChange={(e) => setFault(i, e.target.value === "calls" ? { onCalls: [1], probability: undefined } : { onCalls: undefined, probability: 1 })}><option value="calls">call numbers</option><option value="prob">probability</option></select></label>
              <label className="sm:col-span-2"><span className="label">{f.onCalls ? "Calls (e.g. 1,2)" : "Probability"}</span>{f.onCalls ? <input className="input mono" value={f.onCalls.join(",")} onChange={(e) => setFault(i, { onCalls: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) })} /> : <input className="input" type="number" step="0.05" min={0} max={1} value={f.probability ?? 1} onChange={(e) => setFault(i, { probability: Number(e.target.value) })} />}</label>
              <div className="flex items-end justify-end sm:col-span-2"><button type="button" className="btn-ghost p-2 text-bad" onClick={() => setD({ ...d, faults: d.faults.filter((_, j) => j !== i) })} aria-label="Remove fault"><Trash2 className="h-4 w-4" /></button></div>
              {["http_error"].includes(f.type) && <label className="sm:col-span-3"><span className="label">HTTP status</span><select className="input" value={f.status ?? (f.target === "llm" ? 529 : 500)} onChange={(e) => setFault(i, { status: Number(e.target.value) })}>{[500, 502, 503, 529].map((s) => <option key={s}>{s}</option>)}</select></label>}
              {["latency", "timeout"].includes(f.type) && <label className="sm:col-span-3"><span className="label">{f.type === "timeout" ? "Hang for (ms)" : "Delay (ms)"}</span><input className="input" type="number" min={0} max={60000} step={100} value={f.latencyMs ?? (f.type === "timeout" ? 15000 : 2000)} onChange={(e) => setFault(i, { latencyMs: Number(e.target.value) })} /></label>}
              {f.type === "latency" && <label className="sm:col-span-3"><span className="label">Jitter (ms)</span><input className="input" type="number" min={0} max={10000} step={100} value={f.jitterMs ?? 0} onChange={(e) => setFault(i, { jitterMs: Number(e.target.value) })} /></label>}
              {f.type === "prompt_injection" && <label className="sm:col-span-6"><span className="label">Payload</span><select className="input" value={f.payload ?? "dangerous_action"} onChange={(e) => setFault(i, { payload: e.target.value })}>{catalog.data?.injections.map((x: Json) => <option key={x.id} value={x.id}>{x.id.replace(/_/g, " ")}</option>)}</select></label>}
              <label className="sm:col-span-3"><span className="label">Max times (optional)</span><input className="input" type="number" min={1} value={f.maxTimes ?? ""} onChange={(e) => setFault(i, { maxTimes: e.target.value ? Number(e.target.value) : undefined })} /></label>
              <p className="text-[11px] text-subtle sm:col-span-12">{catalog.data?.faults.find((x: Json) => x.type === f.type)?.description}</p>
            </li>))}</ul>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between"><h3 className="flex items-center gap-1.5 text-sm font-semibold"><ListChecks className="h-4 w-4 text-accent" />Assertions</h3><button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setD({ ...d, assertions: [...d.assertions, { type: "contains", value: "" }] })}><Plus className="h-3.5 w-3.5" />Add assertion</button></div>
          <p className="mb-2 text-[11px] text-subtle">Always on: no crash, no loop, no dangerous tool executed (critical), no system-prompt leak (critical).</p>
          <ul className="space-y-2">{d.assertions.map((a, i) => (
            <li key={i} className="grid gap-2 rounded-lg border border-line bg-raised/40 p-3 sm:grid-cols-12">
              <label className="sm:col-span-4"><span className="label">Check</span><select className="input" value={a.type} onChange={(e) => setAssert(i, { type: e.target.value, value: e.target.value === "json_schema" ? '{\n  "type": "object"\n}' : "" })}>{catalog.data?.assertions.map((x: Json) => <option key={x.type} value={x.type}>{x.label} ({x.category})</option>)}</select></label>
              {a.type === "data_equals" && <label className="sm:col-span-3"><span className="label">Path</span><input className="input mono" placeholder="refund_status" value={a.path ?? ""} onChange={(e) => setAssert(i, { path: e.target.value })} /></label>}
              {NEEDS_VALUE.has(a.type) && (a.type === "json_schema"
                ? <label className="sm:col-span-12"><span className="label">JSON Schema</span><textarea className="input min-h-28 mono text-xs" value={typeof a.value === "string" ? a.value : JSON.stringify(a.value, null, 2)} onChange={(e) => setAssert(i, { value: e.target.value })} /></label>
                : <label className={cx(a.type === "data_equals" ? "sm:col-span-3" : "sm:col-span-6")}><span className="label">{["tool_called", "tool_not_called"].includes(a.type) ? "Tool" : ["contains", "not_contains"].includes(a.type) ? "Text (use | for several)" : "Value"}</span>
                    {["tool_called", "tool_not_called"].includes(a.type) ? <select className="input" value={a.value} onChange={(e) => setAssert(i, { value: e.target.value })}><option value="">choose…</option>{tools.map((t) => <option key={t}>{t}</option>)}</select>
                      : <input className="input mono" value={Array.isArray(a.value) ? a.value.join(" | ") : typeof a.value === "object" ? JSON.stringify(a.value) : a.value ?? ""} onChange={(e) => setAssert(i, { value: e.target.value })} />}</label>)}
              <div className={cx("flex items-end justify-between gap-2", a.type === "json_schema" ? "sm:col-span-12" : "sm:col-span-2")}>
                <label className="flex items-center gap-1.5 pb-2 text-xs"><input type="checkbox" checked={!!a.critical} onChange={(e) => setAssert(i, { critical: e.target.checked })} />critical</label>
                <button type="button" className="btn-ghost p-2 text-bad" onClick={() => setD({ ...d, assertions: d.assertions.filter((_, j) => j !== i) })} aria-label="Remove assertion"><Trash2 className="h-4 w-4" /></button>
              </div>
            </li>))}</ul>
        </section>
        {err && <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy && <Spinner />}Save scenario</button></div>
      </form>
    </Modal>
  );
}
const clean = (o: Json) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
