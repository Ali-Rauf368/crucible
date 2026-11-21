"use client";
import Link from "next/link";
import { useMemo } from "react";
import { Gauge, ShieldCheck, Zap, Repeat, ShieldAlert, DollarSign, Activity, Trophy, Radio, ArrowRight, Rocket, PlayCircle, Flame } from "lucide-react";
import { useApi } from "@/lib/api";
import { pct, usd, num, ago } from "@/lib/format";
import { Card, CardHeader, PageHeader, Stat, Skeleton, ErrorBox, Empty, Badge, cx } from "@/components/ui";
import { Lines, RadarScores, FaultSurvival, Donut, Traffic, COLORS } from "@/components/charts";
import { OUTCOMES, OutcomeBar, RunStatus, FAULT_COLORS } from "@/components/domain";
import { useLiveEvents, useOpenRun, useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function Overview() {
  const o = useApi<Json>("/api/overview", { refreshMs: 30_000 });
  const openRun = useOpenRun();
  const user = useSession();
  useLiveEvents((e) => { if (e.type === "run.finished" || e.type === "run.created") o.reload(); });

  const trend = useMemo(() => {
    if (!o.data) return { rows: [], agents: [] as string[] };
    const agents = [...new Set<string>(o.data.trend.map((r: Json) => r.agent))];
    const rows = o.data.trend.map((r: Json) => ({ t: r.t, [r.agent]: r.overall }));
    return { rows, agents };
  }, [o.data]);
  const radar = useMemo(() => {
    if (!o.data) return [];
    const by = new Map<string, Json[]>();
    for (const r of o.data.leaderboard) by.set(r.agent, [...(by.get(r.agent) ?? []), r]);
    return [...by.entries()].map(([label, rs], i) => ({ label, color: COLORS[i], scores: { accuracy: avg(rs.map((r) => r.scores.accuracy)), safety: avg(rs.map((r) => r.scores.safety)), resilience: avg(rs.map((r) => r.scores.resilience)), passRate: avg(rs.map((r) => r.pass_rate)) } }));
  }, [o.data]);

  if (o.error && !o.data) return <ErrorBox message={o.error} onRetry={o.reload} />;
  if (!o.data) return <div className="space-y-4"><Skeleton className="h-16" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-80" /></div>;
  const { kpi, recent, faults, outcomes, traffic, leaderboard } = o.data;
  const totalOutcomes = outcomes.reduce((a: number, x: Json) => a + x.n, 0);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Last 7 days" title="Agent reliability overview" subtitle="How your agents hold up under injected failures and attacks, before production finds out."
        actions={can(user, "engineer") && <button className="btn-primary" onClick={() => openRun()}><Rocket className="h-4 w-4" />New run</button>} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Case pass rate" value={pct(kpi.pass_rate)} icon={Gauge} tone={kpi.pass_rate >= 0.85 ? "ok" : kpi.pass_rate >= 0.7 ? "warn" : "bad"} hint={`${num(kpi.cases)} cases · ${kpi.runs} runs`} />
        <Stat label="Resilience score" value={pct(kpi.resilience, 0)} icon={Activity} tone="info" hint={`${num(kpi.faults)} faults injected`} />
        <Stat label="Safety score" value={pct(kpi.safety, 0)} icon={ShieldCheck} tone={kpi.unsafe ? "bad" : "ok"} hint={<span className={kpi.unsafe ? "text-bad" : ""}>{kpi.unsafe} unsafe outcomes caught</span>} />
        <Stat label="Eval spend" value={usd(kpi.cost)} icon={DollarSign} tone="accent" hint={`${num(Number(kpi.tokens))} tokens through the proxy`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="Overall score by run" subtitle="Weighted accuracy · safety · resilience for each completed run" icon={Activity} action={<Link href="/runs" className="btn-ghost px-2 py-1 text-xs">All runs<ArrowRight className="h-3.5 w-3.5" /></Link>} />
          {trend.rows.length ? <Lines data={trend.rows} series={trend.agents.map((a, i) => ({ key: a, label: a, color: COLORS[i] }))} height={260} /> : <Empty icon={PlayCircle} title="No completed runs yet" message="Launch a run to see trends." />}
        </Card>
        <Card className="card-pad">
          <CardHeader title="Agent leaderboard" subtitle="Latest run per suite, averaged" icon={Trophy} />
          {radar.length ? <RadarScores series={radar} height={260} /> : <Empty title="No data" />}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="card-pad">
          <CardHeader title="Fault survival" subtitle="Share of cases that still passed when this fault fired" icon={Zap} action={<Link href="/chaos" className="btn-ghost px-2 py-1 text-xs">Chaos studio</Link>} />
          {faults.length ? <FaultSurvival data={faults.map((f: Json) => ({ ...f, color: FAULT_COLORS[f.type] ?? "#888" }))} /> : <Empty icon={Zap} title="No faults injected yet" />}
        </Card>
        <Card className="card-pad">
          <CardHeader title="Outcomes" subtitle="What happened to every evaluated case" icon={Flame} />
          <Donut height={170} data={outcomes.map((x: Json) => ({ name: OUTCOMES[x.outcome]?.label ?? x.outcome, value: x.n, color: OUTCOMES[x.outcome]?.color ?? "#888" }))} center={<div className="text-center"><p className="text-2xl font-semibold tabular-nums">{totalOutcomes}</p><p className="text-[10px] uppercase tracking-wider text-subtle">cases</p></div>} />
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {outcomes.map((x: Json) => <li key={x.outcome} className="flex items-center justify-between gap-2" title={OUTCOMES[x.outcome]?.help}><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: OUTCOMES[x.outcome]?.color }} />{OUTCOMES[x.outcome]?.label ?? x.outcome}</span><span className="tabular-nums text-muted">{x.n}</span></li>)}
          </ul>
        </Card>
        <Card className="card-pad lg:col-span-2 xl:col-span-1">
          <CardHeader title="Proxy traffic" subtitle="LLM + tool calls per minute, last hour" icon={Radio} action={<Link href="/traffic" className="btn-ghost px-2 py-1 text-xs">Live view</Link>} />
          {traffic.length ? <Traffic data={traffic} height={230} /> : <Empty icon={Radio} title="No traffic in the last hour" />}
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-5 [&>*]:min-w-0">
        <Card className="xl:col-span-3">
          <div className="card-pad pb-0"><CardHeader title="Recent runs" icon={PlayCircle} /></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-subtle"><th className="px-5 py-2 font-medium">Run</th><th className="px-3 py-2 font-medium">Agent</th><th className="px-3 py-2 font-medium">Outcomes</th><th className="px-3 py-2 text-right font-medium">Pass</th><th className="px-5 py-2 text-right font-medium">Score</th></tr></thead>
              <tbody>{recent.map((r: Json) => (
                <tr key={r.id} className="table-row">
                  <td className="px-5 py-2.5"><Link href={`/runs/${r.id}`} className="font-medium hover:text-accent">#{r.id} {r.label}</Link><p className="text-xs text-subtle">{r.suite} · {ago(r.created_at)} {r.is_baseline && <Badge tone="accent" className="ml-1">baseline</Badge>}</p></td>
                  <td className="px-3 py-2.5 text-muted">{r.agent}</td>
                  <td className="w-40 px-3 py-2.5">{r.status === "completed" ? <OutcomeBar outcomes={r.summary?.outcomes} /> : <RunStatus s={r.status} done={r.done} total={r.total} />}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.summary ? pct(r.summary.passRate, 0) : "—"}</td>
                  <td className={cx("px-5 py-2.5 text-right font-semibold tabular-nums", (r.scores?.overall ?? 0) >= 0.85 ? "text-ok" : (r.scores?.overall ?? 0) >= 0.7 ? "text-warn" : r.scores ? "text-bad" : "text-subtle")}>{r.scores ? Math.round(r.scores.overall * 100) : "—"}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Card>
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="Where agents break" subtitle="Latest run per agent and suite" icon={ShieldAlert} />
          <ul className="space-y-2.5">
            {leaderboard.map((r: Json) => (
              <li key={`${r.agent_id}-${r.suite}`}>
                <Link href={`/runs/${r.run_id}`} className="block rounded-lg border border-line p-3 transition hover:border-accent/50">
                  <div className="flex items-center justify-between gap-2 text-sm"><span className="truncate font-medium">{r.agent}</span><span className={cx("font-semibold tabular-nums", r.pass_rate >= 0.85 ? "text-ok" : r.pass_rate >= 0.6 ? "text-warn" : "text-bad")}>{pct(r.pass_rate, 0)}</span></div>
                  <p className="mt-0.5 truncate text-xs text-subtle">{r.suite} · safety {pct(r.scores.safety, 0)} · resilience {pct(r.scores.resilience, 0)} · {usd(r.cost)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
