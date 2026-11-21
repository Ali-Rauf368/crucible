"use client";
import { useEffect, useState } from "react";
import { FlaskRound, OctagonX, Play, Square, ShieldAlert, Timer, Target } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, Skeleton, Empty, Modal, Spinner, useToast, cx } from "@/components/ui";
import { FAULT_COLORS, FaultChip } from "@/components/domain";
import { useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function Experiments() {
  const ex = useApi<Json[]>("/api/experiments", { refreshMs: 3000 });
  const cat = useApi<Json>("/api/catalog");
  const user = useSession(); const toast = useToast();
  const [create, setCreate] = useState(false), [kill, setKill] = useState(false);
  const engineer = can(user, "engineer");
  const running = ex.data?.filter((e) => e.status === "running") ?? [];
  const stop = async (id: number) => { try { await api(`/api/experiments/${id}/stop`, { method: "POST" }); toast("Experiment stopped", "ok"); ex.reload(); } catch (e) { toast((e as Error).message, "bad"); } };
  const killAll = async () => { const r = await api<{ stopped: number }>("/api/experiments/stop-all", { method: "POST" }); toast(`Kill switch: ${r.stopped} experiment(s) stopped`, "ok"); setKill(false); ex.reload(); };

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Chaos" title="Live chaos experiments" subtitle="Inject faults into a slice of real proxy traffic (not test runs) to verify production agents degrade gracefully. Every experiment has a blast-radius cap, an expiry and a kill switch."
        actions={engineer && <>
          <button className="btn-danger" onClick={() => setKill(true)} disabled={!running.length}><OctagonX className="h-4 w-4" />Kill switch{running.length ? ` (${running.length})` : ""}</button>
          <button className="btn-primary" onClick={() => setCreate(true)}><Play className="h-4 w-4" />New experiment</button>
        </>} />
      {running.length > 0 && <div className="flex items-center gap-2 rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad" role="status"><span className="relative flex h-2.5 w-2.5"><span className="absolute inset-0 animate-pulseRing rounded-full bg-bad" /><span className="relative h-2.5 w-2.5 rounded-full bg-bad" /></span><b>{running.length} experiment{running.length > 1 ? "s are" : " is"} injecting faults into live traffic.</b></div>}
      {!ex.data ? <Skeleton className="h-64" /> : !ex.data.length ? <Empty icon={FlaskRound} title="No experiments yet" message="Start small: 5% of traffic, 20 injections, 15 minutes." /> : (
        <div className="grid gap-4 lg:grid-cols-2">{ex.data.map((e) => <ExperimentCard key={e.id} e={e} onStop={engineer ? () => stop(e.id) : undefined} />)}</div>
      )}
      <CreateExperiment open={create} catalog={cat.data} onClose={() => setCreate(false)} onDone={() => { setCreate(false); ex.reload(); }} />
      <Modal open={kill} onClose={() => setKill(false)} title="Stop all live experiments?" footer={<><button className="btn-secondary" onClick={() => setKill(false)}>Cancel</button><button className="btn-danger" onClick={killAll}><OctagonX className="h-4 w-4" />Stop everything</button></>}>
        <p className="text-sm text-muted">All {running.length} running experiment(s) stop immediately on every proxy replica (within ~2 seconds). This is audited.</p>
      </Modal>
    </div>
  );
}

function ExperimentCard({ e, onStop }: { e: Json; onStop?: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const live = e.status === "running";
  const left = Math.max(0, new Date(e.expires_at).getTime() - now);
  const used = e.injected / e.max_injections;
  return (
    <Card className={cx("card-pad", live && "border-bad/40")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{e.name}</p><Badge tone={live ? "bad" : e.status === "completed" ? "ok" : "neutral"} dot>{e.status}</Badge></div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted"><FaultChip type={e.fault.type} target={e.fault.target} /><span className="flex items-center gap-1"><Target className="h-3 w-3" />{e.traffic_pct}% of traffic</span>{e.fault.latencyMs && <span>{e.fault.latencyMs} ms</span>}{e.fault.status && <span>HTTP {e.fault.status}</span>}</div>
        </div>
        {live && onStop && <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={onStop}><Square className="h-3.5 w-3.5" />Stop</button>}
      </div>
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-xs"><span className="flex items-center gap-1 text-muted"><ShieldAlert className="h-3 w-3" />Blast radius</span><span className="tabular-nums">{e.injected} / {e.max_injections} injections · {e.eligible} eligible calls</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, used * 100)}%`, background: FAULT_COLORS[e.fault.type] ?? "rgb(var(--accent))" }} /></div>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span>started {ago(e.created_at)} by {e.created_by}</span>
        {live ? <span className="flex items-center gap-1 text-warn"><Timer className="h-3 w-3" />auto-stops in {Math.floor(left / 60000)}m {Math.floor((left % 60000) / 1000)}s</span> : <span>ended {e.stopped_at ? dateTime(e.stopped_at) : "—"}{e.stop_reason ? ` · ${e.stop_reason}` : ""}</span>}
      </p>
    </Card>
  );
}

function CreateExperiment({ open, catalog, onClose, onDone }: { open: boolean; catalog: Json; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", type: "latency", target: "llm", pct: 5, max: 20, minutes: 15, latencyMs: 3000, status: 503 });
  const [busy, setBusy] = useState(false); const toast = useToast();
  const faults = catalog?.faults.filter((x: Json) => x.targets.includes(f.target === "llm" ? "llm" : "tool")) ?? [];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const fault = { type: f.type, target: f.target, ...(f.type === "http_error" ? { status: f.status } : {}), ...(["latency", "timeout"].includes(f.type) ? { latencyMs: f.latencyMs } : {}) };
      await api("/api/experiments", { method: "POST", json: { name: f.name, fault, trafficPct: f.pct, maxInjections: f.max, durationMinutes: f.minutes } });
      toast("Experiment started", "ok"); onDone();
    } catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Start a live chaos experiment">
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="label">Name / hypothesis</span><input className="input" required minLength={3} placeholder="Checkout agent survives 3 s LLM latency" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="label">Target</span><select className="input" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value, type: e.target.value === "llm" ? "latency" : "http_error" })}><option value="llm">LLM calls</option><option value="tool">All tools</option>{catalog?.tools.map((t: Json) => <option key={t.name} value={`tool:${t.name}`}>tool: {t.name}</option>)}</select></label>
          <label className="block"><span className="label">Fault</span><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{faults.map((x: Json) => <option key={x.type} value={x.type}>{x.label}</option>)}</select></label>
        </div>
        {["latency", "timeout"].includes(f.type) && <label className="block"><span className="label">Delay (ms)</span><input className="input" type="number" min={100} max={30000} step={100} value={f.latencyMs} onChange={(e) => setF({ ...f, latencyMs: Number(e.target.value) })} /></label>}
        {f.type === "http_error" && <label className="block"><span className="label">Status</span><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: Number(e.target.value) })}>{[500, 502, 503, 529].map((s) => <option key={s}>{s}</option>)}</select></label>}
        <div className="grid grid-cols-3 gap-3">
          <label className="block"><span className="label">% of traffic</span><input className="input" type="number" min={0.1} max={100} step={0.1} value={f.pct} onChange={(e) => setF({ ...f, pct: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Max injections</span><input className="input" type="number" min={1} max={100000} value={f.max} onChange={(e) => setF({ ...f, max: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Duration (min)</span><input className="input" type="number" min={1} max={1440} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /></label>
        </div>
        <p className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn">Affects real callers of the proxy (requests without a test session). Stops automatically at the cap or the deadline.</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy && <Spinner />}Start experiment</button></div>
      </form>
    </Modal>
  );
}
