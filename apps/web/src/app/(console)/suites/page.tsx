"use client";
import Link from "next/link";
import { useState } from "react";
import { FlaskConical, Plus, Zap, ShieldAlert, Rocket } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { pct, ago } from "@/lib/format";
import { Card, PageHeader, Badge, Skeleton, Empty, Modal, Spinner, useToast } from "@/components/ui";
import { OutcomeBar } from "@/components/domain";
import { useOpenRun, useSession, can } from "@/components/shell";
import { ResponsiveContainer, AreaChart, Area, YAxis } from "recharts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function Suites() {
  const suites = useApi<Json[]>("/api/suites");
  const [create, setCreate] = useState(false);
  const user = useSession(); const openRun = useOpenRun();
  return (
    <div>
      <PageHeader title="Test suites" subtitle="Scenarios with inputs, reference answers, assertions and a fault plan. Suites carry the pass threshold and CI regression budget."
        actions={can(user, "engineer") && <button className="btn-primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New suite</button>} />
      {!suites.data ? <Skeleton className="h-64" /> : !suites.data.length ? <Empty icon={FlaskConical} title="No suites" /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {suites.data.map((s) => (
            <Card key={s.id} className="card-pad flex flex-col transition hover:border-accent/40">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/suites/${s.id}`} className="font-semibold hover:text-accent">{s.name}</Link>
                {s.slug.includes("redteam") ? <ShieldAlert className="h-4 w-4 shrink-0 text-bad" /> : <FlaskConical className="h-4 w-4 shrink-0 text-accent" />}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{s.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5"><Badge>{s.scenarios} scenarios</Badge><Badge tone="accent"><Zap className="h-3 w-3" />{s.chaos_scenarios} with chaos</Badge><Badge>gate ≥ {Math.round(s.thresholds.overall * 100)}</Badge></div>
              {s.trend?.length > 1 && (
                <div className="mt-3 h-12" aria-hidden><ResponsiveContainer><AreaChart data={s.trend}><YAxis hide domain={[0, 1]} /><Area dataKey="overall" type="monotone" stroke="#fb923c" fill="#fb923c" fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div>
              )}
              <div className="mt-auto pt-3">
                {s.last_run ? <><OutcomeBar outcomes={s.last_run.summary?.outcomes} /><p className="mt-1.5 text-xs text-subtle">Last: <Link href={`/runs/${s.last_run.id}`} className="hover:text-fg">{s.last_run.label}</Link> · {pct(s.last_run.summary?.passRate, 0)} pass · {ago(s.last_run.finished_at)}</p></> : <p className="text-xs text-subtle">Never run</p>}
                {can(user, "engineer") && <button className="btn-secondary mt-3 w-full text-xs" onClick={() => openRun({ suiteId: s.id })}><Rocket className="h-3.5 w-3.5" />Run suite</button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <CreateSuite open={create} onClose={() => setCreate(false)} onCreated={(id) => (window.location.href = `/suites/${id}`)} />
    </div>
  );
}

function CreateSuite({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [f, setF] = useState({ name: "", description: "", rubric: "", overall: 0.7, maxRegression: 0.05, maxCostIncreasePct: 25 });
  const [busy, setBusy] = useState(false); const toast = useToast();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const s = await api<Json>("/api/suites", { method: "POST", json: { name: f.name, description: f.description, rubric: f.rubric, thresholds: { overall: f.overall, maxRegression: f.maxRegression, maxCostIncreasePct: f.maxCostIncreasePct } } }); onCreated(s.id); }
    catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New test suite">
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="label">Name</span><input className="input" required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="block"><span className="label">Description</span><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <label className="block"><span className="label">Judge rubric</span><textarea className="input min-h-20" placeholder="What does a great answer look like? What is never acceptable?" value={f.rubric} onChange={(e) => setF({ ...f, rubric: e.target.value })} /></label>
        <div className="grid grid-cols-3 gap-2">
          <label className="block"><span className="label">Pass threshold</span><input className="input" type="number" step="0.05" min={0} max={1} value={f.overall} onChange={(e) => setF({ ...f, overall: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Max score drop</span><input className="input" type="number" step="0.01" min={0} max={1} value={f.maxRegression} onChange={(e) => setF({ ...f, maxRegression: Number(e.target.value) })} /></label>
          <label className="block"><span className="label">Max cost +%</span><input className="input" type="number" min={0} value={f.maxCostIncreasePct} onChange={(e) => setF({ ...f, maxCostIncreasePct: Number(e.target.value) })} /></label>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy && <Spinner />}Create</button></div>
      </form>
    </Modal>
  );
}
