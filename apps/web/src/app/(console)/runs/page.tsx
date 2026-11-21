"use client";
import Link from "next/link";
import { useState } from "react";
import { PlayCircle, Rocket, Star, GitBranch } from "lucide-react";
import { useApi } from "@/lib/api";
import { pct, usd, ago } from "@/lib/format";
import { Card, PageHeader, Badge, Skeleton, ErrorBox, Empty, cx } from "@/components/ui";
import { OutcomeBar, RunStatus } from "@/components/domain";
import { useLiveEvents, useOpenRun, useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function Runs() {
  const [suite, setSuite] = useState(""), [agent, setAgent] = useState("");
  const runs = useApi<Json[]>(`/api/runs?limit=100${suite ? `&suite=${suite}` : ""}${agent ? `&agent=${agent}` : ""}`);
  const suites = useApi<Json[]>("/api/suites"), agents = useApi<Json[]>("/api/agents");
  const openRun = useOpenRun(); const user = useSession();
  useLiveEvents((e) => { if (e.type.startsWith("run.")) runs.reload(); });
  return (
    <div>
      <PageHeader title="Runs" subtitle="Every evaluation execution, with its seed, so any result can be reproduced exactly."
        actions={<>
          <select className="input w-auto" value={suite} onChange={(e) => setSuite(e.target.value)} aria-label="Filter by suite"><option value="">All suites</option>{suites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select className="input w-auto" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filter by agent"><option value="">All agents</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          {can(user, "engineer") && <button className="btn-primary" onClick={() => openRun()}><Rocket className="h-4 w-4" />New run</button>}
        </>} />
      {runs.error && !runs.data ? <ErrorBox message={runs.error} onRetry={runs.reload} /> : !runs.data ? <Skeleton className="h-96" /> : !runs.data.length ? <Empty icon={PlayCircle} title="No runs yet" message="Launch a suite against an agent to get started." /> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-subtle"><th className="px-4 py-2.5 font-medium">Run</th><th className="hidden px-3 py-2.5 font-medium md:table-cell">Suite</th><th className="px-3 py-2.5 font-medium">Status</th><th className="hidden w-44 px-3 py-2.5 font-medium lg:table-cell">Outcomes</th><th className="px-3 py-2.5 text-right font-medium">Pass</th><th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Cost</th><th className="px-4 py-2.5 text-right font-medium">Score</th></tr></thead>
            <tbody>{runs.data.map((r) => (
              <tr key={r.id} className="table-row">
                <td className="px-4 py-3">
                  <Link href={`/runs/${r.id}`} className="font-medium hover:text-accent">#{r.id} {r.label}</Link>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">{r.agent} · {ago(r.created_at)}{r.is_baseline && <Badge tone="accent"><Star className="h-3 w-3" />baseline</Badge>}{r.trigger === "ci" && <Badge tone="info"><GitBranch className="h-3 w-3" />CI{r.git_sha ? ` ${r.git_sha.slice(0, 7)}` : ""}</Badge>}</p>
                </td>
                <td className="hidden px-3 py-3 text-muted md:table-cell">{r.suite}</td>
                <td className="px-3 py-3"><RunStatus s={r.status} done={r.done} total={r.total} /></td>
                <td className="hidden px-3 py-3 lg:table-cell"><OutcomeBar outcomes={r.summary?.outcomes} /></td>
                <td className="px-3 py-3 text-right tabular-nums">{r.summary ? pct(r.summary.passRate, 0) : "—"}</td>
                <td className="hidden px-3 py-3 text-right tabular-nums text-muted sm:table-cell">{r.summary ? usd(r.summary.costUsd) : "—"}</td>
                <td className={cx("px-4 py-3 text-right font-semibold tabular-nums", !r.scores ? "text-subtle" : r.scores.overall >= 0.85 ? "text-ok" : r.scores.overall >= 0.7 ? "text-warn" : "text-bad")}>{r.scores ? Math.round(r.scores.overall * 100) : "—"}</td>
              </tr>))}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
