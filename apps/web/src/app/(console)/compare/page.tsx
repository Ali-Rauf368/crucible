"use client";
import Link from "next/link";
import { Suspense, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GitCompareArrows, ShieldCheck, ShieldX, ArrowRight, TrendingDown, TrendingUp, Info } from "lucide-react";
import { useApi } from "@/lib/api";
import { pct, usd } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, Skeleton, ErrorBox, Empty, cx } from "@/components/ui";
import { Delta, OutcomeBadge } from "@/components/domain";
import { GroupedBars } from "@/components/charts";
import { fmtMs } from "@/components/waterfall";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function ComparePage() { return <Suspense fallback={<Skeleton className="h-96" />}><Compare /></Suspense>; }

function Compare() {
  const sp = useSearchParams(); const router = useRouter();
  const base = sp.get("base"), cand = sp.get("cand");
  const runs = useApi<Json[]>("/api/runs?status=completed&limit=200");
  const report = useApi<Json>(base && cand ? `/api/compare?base=${base}&cand=${cand}` : null);
  const baseRun = runs.data?.find((r) => String(r.id) === base);
  const candidates = useMemo(() => (runs.data ?? []).filter((r) => !baseRun || r.suite_id === baseRun.suite_id), [runs.data, baseRun]);
  const set = (k: "base" | "cand", v: string) => { const p = new URLSearchParams(sp.toString()); if (v) p.set(k, v); else p.delete(k); if (k === "base") p.delete("cand"); router.replace(`/compare?${p}`); };
  const d = report.data;

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Regression gate" title="Compare runs" subtitle="Baseline vs candidate on the same suite: what got better, what broke, and whether CI would let it ship." />
      <Card className="card-pad">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-end">
          <label className="block"><span className="label">Baseline</span><select className="input" value={base ?? ""} onChange={(e) => set("base", e.target.value)}><option value="">Choose a run…</option>{runs.data?.map((r) => <option key={r.id} value={r.id}>#{r.id} {r.label} · {r.agent} · {r.suite}{r.is_baseline ? " ★" : ""}</option>)}</select></label>
          <ArrowRight className="mx-auto hidden h-5 w-5 text-subtle md:block" />
          <label className="block"><span className="label">Candidate</span><select className="input" value={cand ?? ""} onChange={(e) => set("cand", e.target.value)} disabled={!base}><option value="">Choose a run…</option>{candidates.filter((r) => String(r.id) !== base).map((r) => <option key={r.id} value={r.id}>#{r.id} {r.label} · {r.agent}</option>)}</select></label>
        </div>
      </Card>

      {!base || !cand ? <Empty icon={GitCompareArrows} title="Pick two runs of the same suite" message="Tip: runs launched with the same seed get an identical fault schedule, so differences come from the agent, not the dice." />
        : report.error ? <ErrorBox message={report.error} /> : !d ? <Skeleton className="h-96" /> : (<>
        <Card className={cx("card-pad border-2", d.gate.passed ? "border-ok/40" : "border-bad/40")}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className={cx("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl", d.gate.passed ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad")}>{d.gate.passed ? <ShieldCheck className="h-7 w-7" /> : <ShieldX className="h-7 w-7" />}</div>
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">{d.gate.passed ? "Gate passed: safe to ship" : "Gate failed: this change would be blocked in CI"}</p>
              {d.gate.reasons.length ? <ul className="mt-1 list-inside list-disc text-sm text-muted">{d.gate.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul> : <p className="text-sm text-muted">No critical regressions, score within {d.gate.thresholds.maxRegression} of baseline, cost within +{d.gate.thresholds.maxCostIncreasePct}%.</p>}
            </div>
            <div className="text-xs text-muted sm:text-right"><p>{d.matched} matched cases</p><p><Link className="hover:text-accent" href={`/runs/${d.baseline.id}`}>#{d.baseline.id}</Link> → <Link className="hover:text-accent" href={`/runs/${d.candidate.id}`}>#{d.candidate.id}</Link></p></div>
          </div>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[["Overall score", d.deltas.overall, false, "pts"], ["Pass rate", d.deltas.passRate, false, "pts"], ["Cost", d.deltas.costPct / 100, true, "%"], ["Latency p95", d.deltas.latencyP95Pct / 100, true, "%"]].map(([label, v, inv, unit]) => (
            <Card key={label as string} className="card-pad">
              <p className="text-xs text-muted">{label as string}</p>
              <p className="mt-1 text-2xl font-semibold"><Delta v={v as number} invert={inv as boolean} suffix={unit === "%" ? "%" : ""} digits={1} /></p>
              {label === "Pass rate" && <p className="mt-1 flex items-center gap-1 text-[11px] text-subtle"><Info className="h-3 w-3" />90% CI [{(d.deltas.passRateCI90[0] * 100).toFixed(0)}, {(d.deltas.passRateCI90[1] * 100).toFixed(0)}] pts (paired bootstrap)</p>}
              {label === "Cost" && <p className="mt-1 text-[11px] text-subtle">{usd(d.baseline.summary?.costUsd)} → {usd(d.candidate.summary?.costUsd)}</p>}
              {label === "Latency p95" && <p className="mt-1 text-[11px] text-subtle">{fmtMs(d.baseline.summary?.latency?.p95 ?? 0)} → {fmtMs(d.candidate.summary?.latency?.p95 ?? 0)}</p>}
              {label === "Overall score" && <p className="mt-1 text-[11px] text-subtle">{pct(d.baseline.scores?.overall, 0)} → {pct(d.candidate.scores?.overall, 0)}</p>}
            </Card>
          ))}
        </div>

        <div className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
          <Card className="card-pad">
            <CardHeader title="Score dimensions" subtitle={`${d.baseline.label} vs ${d.candidate.label}`} icon={GitCompareArrows} />
            <GroupedBars percent data={["accuracy", "safety", "resilience", "overall"].map((k) => ({ name: k[0].toUpperCase() + k.slice(1), baseline: d.baseline.scores?.[k] ?? 0, candidate: d.candidate.scores?.[k] ?? 0 }))} keys={[{ key: "baseline", label: "Baseline", color: "#71717a" }, { key: "candidate", label: "Candidate", color: "#fb923c" }]} height={240} />
          </Card>
          <Card className="card-pad">
            <CardHeader title="Outcome shift" icon={TrendingDown} />
            <GroupedBars data={[...new Set([...Object.keys(d.baseline.summary?.outcomes ?? {}), ...Object.keys(d.candidate.summary?.outcomes ?? {})])].map((k) => ({ name: k, baseline: d.baseline.summary?.outcomes?.[k] ?? 0, candidate: d.candidate.summary?.outcomes?.[k] ?? 0 }))} keys={[{ key: "baseline", label: "Baseline", color: "#71717a" }, { key: "candidate", label: "Candidate", color: "#fb923c" }]} height={240} />
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <FlipList title="Regressions" icon={TrendingDown} tone="bad" items={d.regressions} empty="Nothing that passed before fails now." />
          <FlipList title="Fixes" icon={TrendingUp} tone="ok" items={d.fixes} empty="No previously failing scenarios were fixed." />
        </div>
      </>)}
    </div>
  );
}

function FlipList({ title, icon: Icon, tone, items, empty }: { title: string; icon: typeof TrendingUp; tone: "ok" | "bad"; items: Json[]; empty: string }) {
  return (
    <Card className="card-pad">
      <CardHeader title={`${title} (${items.length})`} icon={Icon} />
      {!items.length ? <p className="text-sm text-muted">{empty}</p> : (
        <ul className="space-y-2">{items.map((f, i) => (
          <li key={i} className={cx("rounded-lg border p-3", tone === "bad" ? "border-bad/25 bg-bad/5" : "border-ok/25 bg-ok/5")}>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{f.scenario}</span>{f.critical && <Badge tone="bad">critical</Badge>}<span className="ml-auto text-xs tabular-nums text-muted">{Math.round(f.overallFrom * 100)} → {Math.round(f.overallTo * 100)}</span></div>
            <div className="mt-1.5 flex items-center gap-1.5 text-xs"><OutcomeBadge o={f.outcomeFrom} /><ArrowRight className="h-3 w-3 text-subtle" /><OutcomeBadge o={f.outcomeTo} /></div>
          </li>))}</ul>
      )}
    </Card>
  );
}
