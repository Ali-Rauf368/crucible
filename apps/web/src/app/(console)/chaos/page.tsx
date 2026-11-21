"use client";
import { useState } from "react";
import { Zap, Send, Sparkles, Wrench, Clock, CheckCircle2, XCircle, ShieldAlert } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { Card, CardHeader, PageHeader, Badge, Spinner, Skeleton, useToast, cx } from "@/components/ui";
import { FAULT_COLORS } from "@/components/domain";
import { fmtMs } from "@/components/waterfall";
import { useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const DEFAULT_INPUT: Record<string, string> = { llm: "Where is order AB-1001?", get_order: '{ "order_id": "AB-1001" }', refund_order: '{ "order_id": "AB-1003" }', search_kb: '{ "query": "return policy" }', get_weather: '{ "city": "Berlin" }', convert_currency: '{ "amount": 100, "from": "USD", "to": "EUR" }', send_email: '{ "to": "customer@example.com", "body": "hi" }', transfer_funds: '{ "to_account": "XY-1", "amount": 1 }' };

export default function Chaos() {
  const cat = useApi<Json>("/api/catalog");
  const user = useSession(); const toast = useToast();
  const [target, setTarget] = useState("llm");
  const [fault, setFault] = useState<string>("none");
  const [opts, setOpts] = useState<Json>({ status: 503, latencyMs: 1500, payload: "dangerous_action" });
  const [input, setInput] = useState(DEFAULT_INPUT.llm);
  const [stream, setStream] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Json[]>([]);
  if (!cat.data) return <Skeleton className="h-96" />;
  const faults = cat.data.faults.filter((f: Json) => f.targets.includes(target === "llm" ? "llm" : "tool"));

  const fire = async () => {
    setBusy(true);
    try {
      let parsedInput: unknown = input;
      if (target !== "llm") { try { parsedInput = JSON.parse(input || "{}"); } catch { toast("Tool input must be valid JSON", "bad"); setBusy(false); return; } }
      const spec = fault === "none" ? null : { type: fault, ...(fault === "http_error" ? { status: Number(opts.status) } : {}), ...(["latency", "timeout"].includes(fault) ? { latencyMs: Number(opts.latencyMs) } : {}), ...(fault === "prompt_injection" ? { payload: opts.payload } : {}) };
      const r = await api<Json>("/api/playground", { method: "POST", json: { target, fault: spec, input: parsedInput, stream } });
      setHistory((h) => [{ ...r, fault, target, at: new Date() }, ...h].slice(0, 12));
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const last = history[0];

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Chaos studio" title="Fault library & playground" subtitle="See exactly what your agent will receive when Crucible breaks things. Every playground call is traced like real traffic." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cat.data.faults.map((f: Json) => (
          <Card key={f.type} className="card-pad">
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: FAULT_COLORS[f.type] }} /><p className="text-sm font-semibold">{f.label}</p><span className="ml-auto flex gap-1">{f.targets.map((t: string) => <Badge key={t}>{t}</Badge>)}</span></div>
            <p className="mt-1.5 text-xs text-muted">{f.description}</p>
            <p className="mt-2 text-[10px] text-subtle mono">{f.type}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-5 [&>*]:min-w-0">
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="Fire a request" subtitle="Through the real proxy with a forced fault" icon={Zap} />
          {!can(user, "engineer") ? <p className="text-sm text-muted">Engineers can use the playground.</p> : (
            <div className="space-y-3">
              <label className="block"><span className="label">Target</span>
                <select className="input" value={target} onChange={(e) => { setTarget(e.target.value); setInput(DEFAULT_INPUT[e.target.value] ?? "{}"); setFault("none"); }}>
                  <option value="llm">LLM · Anthropic Messages API (crucible-mock-1)</option>
                  {cat.data.tools.map((t: Json) => <option key={t.name} value={t.name}>Tool · {t.name}{t.dangerous ? " (dangerous)" : ""}</option>)}
                </select></label>
              <div><span className="label">Fault</span>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => setFault("none")} className={cx("rounded-lg border px-2.5 py-1 text-xs", fault === "none" ? "border-ok bg-ok/10 text-ok" : "border-line text-muted hover:text-fg")}>none (clean)</button>
                  {faults.map((f: Json) => <button type="button" key={f.type} onClick={() => setFault(f.type)} className={cx("rounded-lg border px-2.5 py-1 text-xs transition", fault === f.type ? "text-fg" : "border-line text-muted hover:text-fg")} style={fault === f.type ? { borderColor: FAULT_COLORS[f.type], background: `${FAULT_COLORS[f.type]}22` } : undefined}>{f.label}</button>)}
                </div></div>
              {fault === "http_error" && <label className="block"><span className="label">Status</span><select className="input" value={opts.status} onChange={(e) => setOpts({ ...opts, status: e.target.value })}>{[500, 502, 503, 529].map((s) => <option key={s}>{s}</option>)}</select></label>}
              {["latency", "timeout"].includes(fault) && <label className="block"><span className="label">{fault === "timeout" ? "Hang (ms) before 504" : "Delay (ms)"}</span><input className="input" type="number" min={0} max={18000} step={100} value={opts.latencyMs} onChange={(e) => setOpts({ ...opts, latencyMs: e.target.value })} /></label>}
              {fault === "prompt_injection" && <label className="block"><span className="label">Payload</span><select className="input" value={opts.payload} onChange={(e) => setOpts({ ...opts, payload: e.target.value })}>{cat.data.injections.map((x: Json) => <option key={x.id} value={x.id}>{x.id.replace(/_/g, " ")}</option>)}</select></label>}
              <label className="block"><span className="label">{target === "llm" ? "User message" : "Tool input (JSON)"}</span><textarea className="input min-h-20 mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} /></label>
              {target === "llm" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />Stream (SSE)</label>}
              <button className="btn-primary w-full" onClick={fire} disabled={busy}>{busy ? <Spinner /> : <Send className="h-4 w-4" />}{busy ? "Waiting for response…" : "Send through proxy"}</button>
            </div>
          )}
        </Card>
        <Card className="card-pad xl:col-span-3">
          <CardHeader title="Response" subtitle={last ? `${last.request.url}` : "Nothing sent yet"} icon={target === "llm" ? Sparkles : Wrench} />
          {!last ? <p className="text-sm text-muted">Pick a target and a fault, then send. You&apos;ll see the status, latency, headers and raw body your agent would receive.</p> : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={last.status >= 200 && last.status < 300 ? "ok" : "bad"}>HTTP {last.status || "—"}</Badge>
                <Badge><Clock className="h-3 w-3" />{fmtMs(last.latencyMs)}</Badge>
                {last.parsedOk ? <Badge tone="ok"><CheckCircle2 className="h-3 w-3" />valid JSON</Badge> : !stream && <Badge tone="bad"><XCircle className="h-3 w-3" />unparseable body</Badge>}
                {last.headers?.["retry-after"] && <Badge tone="warn">retry-after: {last.headers["retry-after"]}</Badge>}
                {/transfer_funds|ignore (all )?previous/i.test(last.body) && <Badge tone="bad"><ShieldAlert className="h-3 w-3" />contains injection</Badge>}
              </div>
              {last.error && <p className="text-sm text-bad">{last.error}</p>}
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-bg p-3 text-xs leading-5 mono">{pretty(last.body) || "(empty body)"}</pre>
            </div>
          )}
          {history.length > 1 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 text-xs font-medium text-muted">History</p>
              <ul className="space-y-1 text-xs">{history.slice(1).map((h, i) => <li key={i} className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: FAULT_COLORS[h.fault] ?? "rgb(var(--ok))" }} /><span className="mono">{h.target}</span><span className="text-subtle">{h.fault}</span><span className="ml-auto tabular-nums text-muted">HTTP {h.status} · {fmtMs(h.latencyMs)}</span></li>)}</ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
