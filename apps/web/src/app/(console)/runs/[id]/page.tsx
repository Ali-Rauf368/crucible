"use client";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, RotateCcw, Flag, GitCompareArrows, Square, Download, Search, Zap, Timer, DollarSign, Coins, Gauge, CheckCircle2, XCircle, Star, Scale, FileText, ListChecks, Activity, Bot, Hash, ShieldCheck, ShieldX, Pin } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { pct, usd, num, ms, ago, dateTime } from "@/lib/format";
import { Card, CardHeader, Badge, Skeleton, ErrorBox, Empty, Modal, Spinner, Tabs, useToast, cx } from "@/components/ui";
import { ScoreRing, OutcomeBadge, OutcomeBar, RunStatus, FaultChip, FAULT_COLORS, OUTCOMES } from "@/components/domain";
import { GroupedBars, FaultSurvival } from "@/components/charts";
import { Waterfall, fmtMs } from "@/components/waterfall";
import { useLiveEvents, useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Filter = "all" | "failed" | "critical" | "chaos";

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const run = useApi<Json>(`/api/runs/${id}`);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const user = useSession();
  const toast = useToast();
  const router = useRouter();
  useLiveEvents((e) => { if (e.runId === Number(id)) run.reload(); }, [id]);

  const cases: Json[] = useMemo(() => run.data?.cases ?? [], [run.data]);
  const shown = useMemo(() => cases.filter((c) => (filter === "failed" ? c.passed === false : filter === "critical" ? c.critical : filter === "chaos" ? c.faults_planned.length > 0 : true) && (!query || c.scenario_name.toLowerCase().includes(query.toLowerCase()))), [cases, filter, query]);
  const categories = useMemo(() => {
    const m = new Map<string, { total: number; passed: number }>();
    for (const c of cases.filter((x) => x.scores)) { const v = m.get(c.category) ?? { total: 0, passed: 0 }; v.total++; if (c.passed) v.passed++; m.set(c.category, v); }
    return [...m.entries()].map(([name, v]) => ({ name, rate: v.passed / v.total }));
  }, [cases]);

  if (run.error && !run.data) return <ErrorBox message={run.error} onRetry={run.reload} />;
  if (!run.data) return <div className="space-y-4"><Skeleton className="h-32" /><Skeleton className="h-40" /><Skeleton className="h-96" /></div>;
  const r = run.data, s = r.summary ?? {};
  const live = r.status === "running" || r.status === "queued";
  const engineer = can(user, "engineer");

  const rerun = async () => {
    try { const n = await api<Json>("/api/runs", { method: "POST", json: { suiteId: r.suite_id, agentId: r.agent_id, seed: r.seed, repeats: r.repeats, chaos: r.chaos, label: `${r.label} (re-run)` } }); router.push(`/runs/${n.id}`); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const act = async (path: string, ok: string) => { try { await api(path, { method: "POST" }); toast(ok, "ok"); run.reload(); } catch (e) { toast((e as Error).message, "bad"); } };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `crucible-run-${r.id}.json`; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-5">
      <Link href="/runs" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Runs</Link>
      <Card className="card-pad ember relative overflow-hidden">
        {live && <div className="absolute inset-x-0 top-0 h-0.5 animate-shimmer bg-[linear-gradient(90deg,transparent,rgb(var(--accent)),transparent)] bg-[length:200%_100%]" />}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><RunStatus s={r.status} done={r.done} total={r.total} />{r.is_baseline && <Badge tone="accent"><Star className="h-3 w-3" />baseline</Badge>}<Badge>{r.trigger}</Badge>{!r.chaos && <Badge tone="warn">chaos off</Badge>}{r.gate && <Link href={`/compare?base=${r.gate.baselineRunId}&cand=${r.id}`}><Badge tone={r.gate.passed ? "ok" : "bad"}>{r.gate.passed ? <ShieldCheck className="h-3 w-3" /> : <ShieldX className="h-3 w-3" />}gate {r.gate.passed ? "passed" : "failed"} vs #{r.gate.baselineRunId}</Badge></Link>}</div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">#{r.id} · {r.label}</h1>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1"><Bot className="h-3.5 w-3.5" />{r.agent}</span>
              <Link href={`/suites/${r.suite_id}`} className="flex items-center gap-1 hover:text-fg"><ListChecks className="h-3.5 w-3.5" />{r.suite}</Link>
              <span className="flex items-center gap-1 mono" title="Same seed → identical fault schedule"><Hash className="h-3.5 w-3.5" />seed {r.seed}</span>
              {r.git_sha && <span className="mono">{r.git_sha.slice(0, 7)}</span>}
              <span>{dateTime(r.created_at)}{r.finished_at && ` · took ${fmtMs(new Date(r.finished_at).getTime() - new Date(r.started_at ?? r.created_at).getTime())}`}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {r.baseline && r.status === "completed" && <Link href={`/compare?base=${r.baseline.id}&cand=${r.id}`} className="btn-primary"><GitCompareArrows className="h-4 w-4" />Compare to baseline</Link>}
            {engineer && live && <button className="btn-secondary" onClick={() => act(`/api/runs/${r.id}/cancel`, "Run cancelled")}><Square className="h-4 w-4" />Cancel</button>}
            {engineer && !live && <button className="btn-secondary" onClick={rerun} title="Same suite, agent and seed"><RotateCcw className="h-4 w-4" />Re-run</button>}
            {engineer && r.status === "completed" && !r.is_baseline && <button className="btn-secondary" onClick={() => act(`/api/runs/${r.id}/baseline`, "Baseline updated")}><Flag className="h-4 w-4" />Set baseline</button>}
            <button className="btn-ghost" onClick={exportJson} aria-label="Export JSON"><Download className="h-4 w-4" /></button>
          </div>
        </div>
        {live && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-muted"><span>Executing cases under chaos…</span><span className="tabular-nums">{r.done}/{r.total}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${(r.done / Math.max(1, r.total)) * 100}%` }} /></div>
          </div>
        )}
      </Card>

      <div className="grid gap-5 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="Scorecard" subtitle={`Overall = 40% accuracy + 35% safety + 25% resilience · suite threshold ${Math.round((r.thresholds?.overall ?? 0.7) * 100)}`} icon={Gauge} />
          <div className="flex flex-wrap items-center justify-around gap-4">
            <ScoreRing value={r.scores?.overall} label="Overall" size={112} sub={s.cases ? `${s.passed}/${s.cases} passed` : undefined} />
            <ScoreRing value={r.scores?.accuracy} label="Accuracy" />
            <ScoreRing value={r.scores?.safety} label="Safety" />
            <ScoreRing value={r.scores?.resilience} label="Resilience" />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4">
            {[[CheckCircle2, "Pass rate", pct(s.passRate, 0)], [Timer, "Latency p50 / p95", s.latency ? `${fmtMs(s.latency.p50)} / ${fmtMs(s.latency.p95)}` : "—"], [DollarSign, "Cost", usd(s.costUsd)], [Coins, "Tokens", num(s.tokens)]].map(([Icon, l, v], i) => {
              const I = Icon as typeof Gauge;
              return <div key={i}><p className="flex items-center gap-1 text-[11px] text-subtle"><I className="h-3 w-3" />{l as string}</p><p className="mt-0.5 font-semibold tabular-nums">{v as string}</p></div>;
            })}
          </div>
          {s.outcomes && <div className="mt-4"><OutcomeBar outcomes={s.outcomes} className="h-2.5" /><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">{Object.entries(s.outcomes as Record<string, number>).map(([k, n]) => <span key={k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: OUTCOMES[k]?.color }} />{OUTCOMES[k]?.label ?? k} {n}</span>)}</div></div>}
        </Card>
        <Card className="card-pad">
          <CardHeader title="Fault survival" subtitle="Cases passed when each fault fired" icon={Zap} />
          {s.faults && Object.keys(s.faults).length ? <FaultSurvival data={Object.entries(s.faults as Record<string, { injected: number; survived: number }>).map(([type, v]) => ({ type, cases: v.injected, survived: v.survived, color: FAULT_COLORS[type] ?? "#888" }))} /> : <Empty icon={Zap} title={live ? "Waiting for results" : "No faults fired"} />}
        </Card>
      </div>

      {categories.length > 1 && (
        <Card className="card-pad"><CardHeader title="Pass rate by category" icon={Activity} /><GroupedBars data={categories} keys={[{ key: "rate", label: "Pass rate", color: "#fb923c" }]} percent height={200} /></Card>
      )}

      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={filter} onChange={setFilter} options={[{ value: "all", label: "All", count: cases.length }, { value: "failed", label: "Failed", count: cases.filter((c) => c.passed === false).length }, { value: "critical", label: "Critical", count: cases.filter((c) => c.critical).length }, { value: "chaos", label: "With faults", count: cases.filter((c) => c.faults_planned.length).length }]} />
          <label className="relative sm:w-64"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-subtle" /><input className="input pl-8" placeholder="Filter scenarios" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter scenarios" /></label>
        </div>
        {!shown.length ? <div className="p-6"><Empty title="No cases match" /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-subtle"><th className="px-4 py-2 font-medium">Scenario</th><th className="px-3 py-2 font-medium">Outcome</th><th className="hidden px-3 py-2 font-medium md:table-cell">Faults fired</th><th className="px-3 py-2 text-right font-medium">Score</th><th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Latency</th><th className="hidden px-4 py-2 text-right font-medium lg:table-cell">Calls · cost</th></tr></thead>
              <tbody>{shown.map((c) => (
                <tr key={c.id} className="table-row cursor-pointer" onClick={() => setOpen(c.id)}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">{c.passed == null ? <Spinner className="h-3.5 w-3.5 text-subtle" /> : c.passed ? <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" /> : <XCircle className="h-4 w-4 shrink-0 text-bad" />}<button className="text-left font-medium hover:text-accent">{c.scenario_name}</button>{c.critical && <Badge tone="bad">critical</Badge>}{r.repeats > 1 && <span className="text-xs text-subtle">#{c.attempt}</span>}</div>
                    <p className="ml-6 text-xs text-subtle">{c.category}</p>
                  </td>
                  <td className="px-3 py-2.5"><OutcomeBadge o={c.outcome} /></td>
                  <td className="hidden px-3 py-2.5 md:table-cell"><div className="flex flex-wrap gap-1">{c.faults_injected.length ? [...new Map(c.faults_injected.map((f: Json) => [f.type + f.target, f])).values()].slice(0, 3).map((f: Json) => <FaultChip key={f.type + f.target} type={f.type} target={f.target} />) : <span className="text-xs text-subtle">—</span>}{c.faults_injected.length > 3 && <span className="text-xs text-subtle">+{c.faults_injected.length - 3}</span>}</div></td>
                  <td className={cx("px-3 py-2.5 text-right font-semibold tabular-nums", !c.scores ? "text-subtle" : c.scores.overall >= 0.85 ? "text-ok" : c.scores.overall >= 0.7 ? "text-warn" : "text-bad")}>{c.scores ? Math.round(c.scores.overall * 100) : "—"}</td>
                  <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted sm:table-cell">{ms(c.latency_ms)}</td>
                  <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-muted lg:table-cell">{c.llm_calls}+{c.tool_calls} · {usd(c.cost_usd)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <CaseInspector id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function CaseInspector({ id, onClose }: { id: number | null; onClose: () => void }) {
  const c = useApi<Json>(id ? `/api/cases/${id}` : null);
  const user = useSession(); const toast = useToast(); const router = useRouter();
  const pin = async () => {
    try { const sc = await api<Json>(`/api/cases/${id}/to-scenario`, { method: "POST", json: {} }); toast(`Pinned as “${sc.name}”`, "ok"); router.push(`/suites/${sc.suite_id}`); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const [tab, setTab] = useState<"trace" | "checks" | "judge" | "io">("trace");
  const d = c.data && c.data.id === id ? c.data : null;
  return (
    <Modal open={id != null} onClose={onClose} title={d ? d.scenario_name : "Case"} wide>
      {!d ? <div className="flex justify-center py-10 text-accent"><Spinner className="h-6 w-6" /></div> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {d.passed ? <Badge tone="ok"><CheckCircle2 className="h-3 w-3" />passed</Badge> : d.passed === false ? <Badge tone="bad"><XCircle className="h-3 w-3" />failed</Badge> : <Badge>running</Badge>}
            <OutcomeBadge o={d.outcome} />
            {d.scores && <span className="text-xs text-muted">overall <b className="text-fg">{Math.round(d.scores.overall * 100)}</b> · acc {Math.round(d.scores.accuracy * 100)} · safety {Math.round(d.scores.safety * 100)} · resilience {Math.round(d.scores.resilience * 100)}</span>}
            <span className="ml-auto text-xs text-muted tabular-nums">{ms(d.latency_ms)} · {d.llm_calls} LLM + {d.tool_calls} tool calls · {usd(d.cost_usd)}</span>
            {can(user, "engineer") && d.input != null && <button className="btn-secondary px-2.5 py-1 text-xs" onClick={pin} title="Create a scenario that replays this exact input and fault schedule"><Pin className="h-3.5 w-3.5" />Pin as regression</button>}
          </div>
          {d.faults_injected.length > 0 && (
            <div className="rounded-lg border border-line bg-raised/40 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium"><Zap className="h-3.5 w-3.5 text-accent" />Fault timeline</p>
              <ol className="flex flex-wrap gap-1.5">{groupFaults(d.faults_injected).map((g, i) => <li key={i} className="flex items-center gap-1 text-[11px]"><span className="text-subtle tabular-nums">{i + 1}.</span><FaultChip type={g.type} target={`${g.target} call${g.calls.length > 1 ? "s" : ""} ${g.calls.length > 2 ? `${g.calls[0]}–${g.calls.at(-1)}` : g.calls.join(", ")}`} />{g.calls.length > 1 && <span className="font-semibold text-muted">×{g.calls.length}</span>}</li>)}</ol>
            </div>
          )}
          {d.error && <p className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-sm text-bad mono">{d.error}</p>}
          <Tabs value={tab} onChange={setTab} options={[{ value: "trace", label: "Trace", count: d.spans.length }, { value: "checks", label: "Assertions", count: d.assertions?.length ?? 0 }, { value: "judge", label: "Judge" }, { value: "io", label: "Input / output" }]} />
          {tab === "trace" && <Waterfall spans={d.spans} />}
          {tab === "checks" && (
            <ul className="space-y-1.5">{(d.assertions ?? []).map((a: Json, i: number) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-raised/60 p-2.5 text-sm">
                {a.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" />}
                <div className="min-w-0 flex-1"><p className="font-medium">{a.label} {a.critical && <Badge tone="bad" className="ml-1">critical</Badge>} {a.auto && <Badge className="ml-1">auto</Badge>}</p><p className="text-xs text-muted break-words">{a.detail}</p></div>
                <Badge tone={a.category === "safety" ? "bad" : a.category === "resilience" ? "info" : "accent"}>{a.category}</Badge>
              </li>))}</ul>
          )}
          {tab === "judge" && d.judge && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs"><Scale className="h-4 w-4 text-accent" /><b>{d.judge.mode === "claude" ? `Claude judge (${d.judge.model})` : "Heuristic judge"}</b>{d.judge.fallbackReason && <Badge tone="warn">fell back: {d.judge.fallbackReason}</Badge>}</div>
              <div className="grid grid-cols-3 gap-3">{(["accuracy", "safety", "helpfulness"] as const).map((k) => <div key={k} className="rounded-lg bg-raised/60 p-3"><p className="text-xs capitalize text-muted">{k}</p><p className="text-lg font-semibold tabular-nums">{Math.round(d.judge[k] * 100)}</p></div>)}</div>
              <p className="rounded-lg bg-raised/60 p-3 text-sm leading-relaxed">{d.judge.reasoning}</p>
            </div>
          )}
          {tab === "io" && (
            <div className="space-y-3 text-sm">
              <IO label="Customer input" text={d.input} />
              <IO label="Reference answer" text={d.expected || "(none)"} muted />
              <IO label="Agent output" text={d.output || (d.error ? "(no output: agent failed)" : "(empty)")} />
              {d.data && <IO label="Structured data" text={JSON.stringify(d.data, null, 2)} mono />}
            </div>
          )}
          <p className="flex items-center gap-1 text-[10px] text-subtle mono"><FileText className="h-3 w-3" />session {d.session_id} · trace {d.trace_id ?? "—"} · started {d.started_at ? ago(d.started_at) : "—"}</p>
        </div>
      )}
    </Modal>
  );
}
/** Collapses consecutive identical faults (e.g. a retry storm against an outage) into one entry. */
function groupFaults(fs: { type: string; target: string; call: number }[]) {
  const out: { type: string; target: string; calls: number[] }[] = [];
  for (const f of fs) { const last = out.at(-1); if (last && last.type === f.type && last.target === f.target) last.calls.push(f.call); else out.push({ type: f.type, target: f.target, calls: [f.call] }); }
  return out;
}
const IO = ({ label, text, muted, mono }: { label: string; text: string; muted?: boolean; mono?: boolean }) => <div><p className="mb-1 text-xs font-medium text-muted">{label}</p><pre className={cx("max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-3 text-[13px] leading-relaxed", mono && "mono text-xs", muted && "text-muted")}>{text}</pre></div>;
