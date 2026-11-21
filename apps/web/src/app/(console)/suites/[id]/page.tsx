"use client";
import Link from "next/link";
import { use, useState } from "react";
import { ArrowLeft, Plus, Pencil, Trash2, Zap, Rocket, Scale, Gauge, Copy, Download, WandSparkles, Activity, Replace, ShieldHalf } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { pct, ago } from "@/lib/format";
import { Card, CardHeader, Badge, Skeleton, ErrorBox, Empty, Modal, Spinner, useToast, cx } from "@/components/ui";
import { FaultChip, OutcomeBar, RunStatus } from "@/components/domain";
import { Lines } from "@/components/charts";
import { ScenarioEditor, EMPTY, type ScenarioDraft } from "@/components/scenario-editor";
import { useOpenRun, useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export default function SuitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const s = useApi<Json>(`/api/suites/${id}`);
  const [draft, setDraft] = useState<ScenarioDraft | null>(null);
  const [del, setDel] = useState<Json | null>(null);
  const [fuzz, setFuzz] = useState<Json | null>(null);
  const flaky = useApi<Json[]>(`/api/suites/${id}/flakiness`);
  const owasp = useApi<Json[]>(`/api/suites/${id}/owasp`);
  const user = useSession(); const toast = useToast(); const openRun = useOpenRun();
  const engineer = can(user, "engineer");
  if (s.error && !s.data) return <ErrorBox message={s.error} onRetry={s.reload} />;
  if (!s.data) return <Skeleton className="h-96" />;
  const d = s.data;
  const trend = [...d.runs].filter((r: Json) => r.status === "completed").reverse().map((r: Json) => ({ t: `#${r.id}`, [r.agent]: r.scores?.overall }));
  const agents = [...new Set<string>(d.runs.map((r: Json) => r.agent))];

  const save = async (x: ScenarioDraft) => {
    const body = { name: x.name, category: x.category, input: x.input, expected: x.expected, critical: x.critical, enabled: x.enabled, tags: x.tags, faults: x.faults, assertions: x.assertions };
    await api(x.id ? `/api/scenarios/${x.id}` : `/api/suites/${id}/scenarios`, { method: x.id ? "PUT" : "POST", json: body });
    toast("Scenario saved", "ok"); setDraft(null); s.reload();
  };
  const remove = async () => { await api(`/api/scenarios/${del.id}`, { method: "DELETE" }); toast("Scenario deleted"); setDel(null); s.reload(); };
  const exportSuite = () => {
    const blob = new Blob([JSON.stringify({ name: d.name, description: d.description, rubric: d.rubric, thresholds: d.thresholds, scenarios: d.scenarios.map(({ id: _i, suite_id: _s, created_at: _c, ...rest }: Json) => rest) }, null, 2)], { type: "application/json" }); // eslint-disable-line @typescript-eslint/no-unused-vars
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${d.slug}.suite.json`; a.click();
  };

  return (
    <div className="space-y-5">
      <Link href="/suites" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Suites</Link>
      <Card className="card-pad">
        <div className="flex flex-col gap-4 lg:flex-row lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{d.name}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">{d.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs"><Badge><Gauge className="h-3 w-3" />pass ≥ {Math.round(d.thresholds.overall * 100)}</Badge><Badge>max score drop {d.thresholds.maxRegression}</Badge><Badge>max cost +{d.thresholds.maxCostIncreasePct}%</Badge><Badge className="mono">{d.slug}</Badge></div>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {engineer && <button className="btn-primary" onClick={() => openRun({ suiteId: d.id })}><Rocket className="h-4 w-4" />Run suite</button>}
            {engineer && <button className="btn-secondary" onClick={() => setDraft({ ...EMPTY })}><Plus className="h-4 w-4" />Scenario</button>}
            <button className="btn-ghost" onClick={exportSuite} aria-label="Export suite as JSON" title="Export as JSON"><Download className="h-4 w-4" /></button>
          </div>
        </div>
        {d.rubric && <div className="mt-4 rounded-lg border border-line bg-raised/40 p-3 text-sm"><p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted"><Scale className="h-3.5 w-3.5" />Judge rubric</p>{d.rubric}</div>}
      </Card>

      <div className="grid gap-5 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="xl:col-span-2">
          <div className="card-pad pb-2"><CardHeader title={`Scenarios (${d.scenarios.length})`} subtitle="Click to edit. Faults are applied deterministically from the run's seed." icon={Zap} /></div>
          {!d.scenarios.length ? <div className="p-5"><Empty title="No scenarios yet" /></div> : (
            <ul className="divide-y divide-line">{d.scenarios.map((sc: Json) => (
              <li key={sc.id} className={cx("flex items-start gap-3 px-5 py-3", !sc.enabled && "opacity-50")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{sc.name}</span><Badge>{sc.category}</Badge>{sc.source?.type === "mutation" && <Badge tone="accent"><WandSparkles className="h-3 w-3" />mutation</Badge>}{sc.source?.type === "replay" && <Badge tone="info"><Replace className="h-3 w-3" />replay</Badge>}{sc.critical && <Badge tone="bad">critical</Badge>}{!sc.enabled && <Badge>disabled</Badge>}</div>
                  <p className="mt-0.5 line-clamp-1 text-sm text-muted">“{sc.input}”</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">{sc.faults.map((f: Json, i: number) => <FaultChip key={i} type={f.type} target={f.target} />)}<span className="text-[11px] text-subtle">{sc.assertions.length} assertions</span></div>
                </div>
                {engineer && <div className="flex shrink-0 gap-1">
                  <button className="btn-ghost p-1.5" onClick={() => setDraft(sc)} aria-label={`Edit ${sc.name}`}><Pencil className="h-4 w-4" /></button>
                  <button className="btn-ghost p-1.5" onClick={() => setDraft({ ...sc, id: undefined, name: `${sc.name} (copy)` })} aria-label={`Duplicate ${sc.name}`}><Copy className="h-4 w-4" /></button>
                  <button className="btn-ghost p-1.5 text-accent" onClick={() => setFuzz(sc)} aria-label={`Generate attack mutations of ${sc.name}`} title="Generate attack mutations"><WandSparkles className="h-4 w-4" /></button>
                  <button className="btn-ghost p-1.5 text-bad" onClick={() => setDel(sc)} aria-label={`Delete ${sc.name}`}><Trash2 className="h-4 w-4" /></button>
                </div>}
              </li>))}</ul>
          )}
        </Card>
        <div className="space-y-5">
          <Card className="card-pad"><CardHeader title="Score history" icon={Gauge} />{trend.length > 1 ? <Lines data={trend} series={agents.map((a) => ({ key: a, label: a }))} height={200} /> : <p className="text-sm text-muted">Run the suite a few times to see a trend.</p>}</Card>
          <Card className="card-pad">
            <CardHeader title="Recent runs" icon={Rocket} />
            <ul className="space-y-2">{d.runs.slice(0, 8).map((r: Json) => (
              <li key={r.id}><Link href={`/runs/${r.id}`} className="block rounded-lg border border-line p-2.5 transition hover:border-accent/50">
                <div className="flex items-center justify-between gap-2 text-sm"><span className="truncate">#{r.id} {r.label}</span>{r.status === "completed" ? <span className="font-semibold tabular-nums">{pct(r.summary?.passRate, 0)}</span> : <RunStatus s={r.status} />}</div>
                <p className="text-xs text-subtle">{r.agent} · {ago(r.created_at)}{r.is_baseline ? " · ★ baseline" : ""}</p>
                {r.summary && <OutcomeBar outcomes={r.summary.outcomes} className="mt-1.5 h-1.5" />}
              </Link></li>))}</ul>
          </Card>
        </div>
      </div>
      <OwaspPanel rows={owasp.data} />
      <FlakinessPanel rows={flaky.data} />
      <MutateDialog scenario={fuzz} onClose={() => setFuzz(null)} onDone={(n) => { setFuzz(null); toast(`${n} mutated scenario(s) added`, "ok"); s.reload(); }} />
      <ScenarioEditor draft={draft} onClose={() => setDraft(null)} onSave={save} />
      <Modal open={!!del} onClose={() => setDel(null)} title="Delete scenario?" footer={<><button className="btn-secondary" onClick={() => setDel(null)}>Cancel</button><button className="btn-danger" onClick={remove}>Delete</button></>}>
        <p className="text-sm text-muted">“{del?.name}” will be removed from the suite. Past run results keep their copy of the scenario name.</p>
      </Modal>
    </div>
  );
}

function FlakinessPanel({ rows }: { rows: Json[] | null }) {
  if (!rows) return <Skeleton className="h-40" />;
  const flaky = rows.filter((r) => r.verdict === "flaky").length;
  return (
    <Card>
      <div className="card-pad pb-2"><CardHeader title="Flakiness & stability" subtitle={`Across the last 20 runs · ${flaky} flaky scenario/agent pair${flaky === 1 ? "" : "s"}. pass@k = any of k repeats passes · pass^k = all k pass (consistency)`} icon={Activity} /></div>
      {!rows.length ? <p className="px-5 pb-5 text-sm text-muted">Run the suite to collect history.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-subtle"><th className="px-5 py-2 font-medium">Scenario</th><th className="px-3 py-2 font-medium">Agent</th><th className="px-3 py-2 font-medium">History (oldest → newest)</th><th className="px-3 py-2 text-right font-medium">Pass</th><th className="hidden px-3 py-2 text-right font-medium md:table-cell">pass@k / pass^k</th><th className="px-5 py-2 text-right font-medium">Verdict</th></tr></thead>
            <tbody>{rows.slice(0, 40).map((r, i) => (
              <tr key={i} className="table-row">
                <td className="px-5 py-2">{r.scenario}{r.critical && <Badge tone="bad" className="ml-1.5">critical</Badge>}</td>
                <td className="px-3 py-2 text-xs text-muted">{r.agent}</td>
                <td className="px-3 py-2"><div className="flex gap-0.5">{r.history.map((h: Json, j: number) => <Link key={j} href={`/runs/${h.runId}`} title={`run #${h.runId}: ${h.outcome}`} className={cx("h-3.5 w-2 rounded-sm", h.passed ? "bg-ok" : "bg-bad")} />)}</div></td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(r.passRate * 100)}%</td>
                <td className="hidden px-3 py-2 text-right text-xs tabular-nums text-muted md:table-cell">{r.passAtK == null ? "—" : `${Math.round(r.passAtK * 100)}% / ${Math.round(r.passHatK * 100)}%`}</td>
                <td className="px-5 py-2 text-right"><Badge tone={r.verdict === "flaky" ? "warn" : r.verdict === "stable pass" ? "ok" : r.verdict === "stable fail" ? "bad" : "neutral"}>{r.verdict}</Badge></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function MutateDialog({ scenario, onClose, onDone }: { scenario: Json | null; onClose: () => void; onDone: (n: number) => void }) {
  const mutators = useApi<Json[]>(scenario ? "/api/mutators" : null);
  const [picked, setPicked] = useState<string[]>(["base64", "leetspeak", "zero_width", "translation"]);
  const [busy, setBusy] = useState(false); const toast = useToast();
  const go = async () => {
    setBusy(true);
    try { const r = await api<Json[]>(`/api/scenarios/${scenario.id}/mutate`, { method: "POST", json: { strategies: picked } }); onDone(r.length); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!scenario} onClose={onClose} title="Generate attack mutations"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={go} disabled={busy || !picked.length}>{busy && <Spinner />}<WandSparkles className="h-4 w-4" />Add {picked.length} scenario{picked.length === 1 ? "" : "s"}</button></>}>
      <p className="mb-3 text-sm text-muted">Rewrites the input of <b className="text-fg">{scenario?.name}</b> into obfuscated variants that capable models still understand but keyword/regex guards miss. Assertions and faults are copied.</p>
      <ul className="space-y-1.5">{mutators.data?.map((m) => (
        <li key={m.id}><label className={cx("flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition", picked.includes(m.id) ? "border-accent/50 bg-accent/5" : "border-line")}>
          <input type="checkbox" className="mt-1" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
          <span><span className="text-sm font-medium">{m.label}</span><span className="block text-xs text-muted">{m.description}</span></span>
        </label></li>))}</ul>
    </Modal>
  );
}

function OwaspPanel({ rows }: { rows: Json[] | null }) {
  if (!rows) return <Skeleton className="h-40" />;
  const covered = rows.filter((r) => r.scenarios.length).length;
  return (
    <Card className="card-pad">
      <CardHeader title="OWASP Top 10 for LLM apps" subtitle={`${covered}/10 risk categories covered by this suite · pass rate from each agent's latest run`} icon={ShieldHalf} />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{rows.map((r) => (
        <div key={r.id} className={cx("rounded-lg border p-3", r.scenarios.length ? "border-line bg-raised/40" : "border-dashed border-line opacity-60")} title={r.scenarios.map((s: Json) => s.name).join("\n") || "Not covered"}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-subtle">{r.id}</p>
          <p className="mt-0.5 text-sm font-medium leading-snug">{r.name}</p>
          {!r.scenarios.length ? <p className="mt-2 text-xs text-subtle">Not covered</p> : (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted">{r.scenarios.length} scenario{r.scenarios.length > 1 ? "s" : ""}</p>
              {r.agents.filter((a: Json) => a.cases).map((a: Json) => (
                <div key={a.agent} className="flex items-center justify-between gap-2 text-xs"><span className="truncate text-muted">{a.agent}</span><span className={cx("font-semibold tabular-nums", a.passRate >= 0.9 ? "text-ok" : a.passRate >= 0.5 ? "text-warn" : "text-bad")}>{Math.round(a.passRate * 100)}%</span></div>
              ))}
            </div>
          )}
        </div>))}</div>
    </Card>
  );
}
