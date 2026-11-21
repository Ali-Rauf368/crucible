"use client";
import Link from "next/link";
import { useState } from "react";
import { CalendarClock, Plus, Play, Trash2, Bell, BellOff, Send, CheckCircle2, XCircle } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { ago, pct } from "@/lib/format";
import { Card, PageHeader, Badge, Skeleton, Empty, Modal, Spinner, Toggle, useToast, cx } from "@/components/ui";
import { useLiveEvents, useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const every = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m > 1440 ? "s" : ""}` : m % 60 === 0 ? `${m / 60} hour${m > 60 ? "s" : ""}` : `${m} min`);

export default function Schedules() {
  const s = useApi<Json[]>("/api/schedules", { refreshMs: 20_000 });
  const [create, setCreate] = useState(false);
  const user = useSession(); const toast = useToast();
  const engineer = can(user, "engineer");
  useLiveEvents((e) => { if (e.type === "run.finished") s.reload(); });
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok, "ok"); s.reload(); } catch (e) { toast((e as Error).message, "bad"); } };
  return (
    <div className="space-y-5">
      <PageHeader title="Scheduled runs" subtitle="Continuous evaluation: re-run suites on a cadence (catching model drift and upstream changes), gate each run against the baseline and alert a Slack-compatible webhook."
        actions={engineer && <button className="btn-primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New schedule</button>} />
      {!s.data ? <Skeleton className="h-64" /> : !s.data.length ? <Empty icon={CalendarClock} title="No schedules" message="E.g. run the red-team suite against production agents every 6 hours." /> : (
        <div className="space-y-3">{s.data.map((x) => (
          <Card key={x.id} className={cx("card-pad", !x.enabled && "opacity-60")}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><CalendarClock className="h-4 w-4 text-accent" /><span className="font-semibold">{x.agent}</span><span className="text-muted">×</span><span className="font-semibold">{x.suite}</span><Badge>every {every(x.interval_minutes)}</Badge>
                  {x.last_status === "gate_failed" ? <Badge tone="bad"><XCircle className="h-3 w-3" />last gate failed</Badge> : x.last_status === "passed" ? <Badge tone="ok"><CheckCircle2 className="h-3 w-3" />last gate passed</Badge> : x.last_status ? <Badge tone="info">{x.last_status}</Badge> : null}</div>
                <p className="mt-1 text-xs text-muted">
                  {x.enabled ? `next run ${new Date(x.next_run_at) < new Date() ? "now" : `in ${Math.max(1, Math.round((new Date(x.next_run_at).getTime() - Date.now()) / 60000))} min`}` : "paused"}
                  {x.last_run_id && <> · last <Link href={`/runs/${x.last_run_id}`} className="hover:text-fg">run #{x.last_run_id}</Link>{x.last_scores && ` (overall ${pct(x.last_scores.overall, 0)})`}{x.last_finished_at && ` ${ago(x.last_finished_at)}`}</>}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-subtle">{x.webhook_url && x.notify !== "never" ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}{x.webhook_url ? `${x.notify === "always" ? "every run" : x.notify === "failures" ? "gate failures" : "muted"} → ${new URL(x.webhook_url).host}` : "no webhook"}
                  {x.deliveries?.[0] && <span className={x.deliveries[0].error ? "text-bad" : "text-ok"}>· last delivery {x.deliveries[0].error ?? `HTTP ${x.deliveries[0].status}`} {ago(x.deliveries[0].created_at)}</span>}</p>
                {x.last_gate?.reasons?.length > 0 && <ul className="mt-1.5 list-inside list-disc text-xs text-bad">{x.last_gate.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>}
              </div>
              {engineer && <div className="flex flex-wrap items-center gap-2">
                <Toggle label={`Enable schedule ${x.id}`} checked={x.enabled} onChange={(v) => act(() => api(`/api/schedules/${x.id}`, { method: "PUT", json: { enabled: v } }), v ? "Schedule resumed" : "Schedule paused")} />
                <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => act(() => api(`/api/schedules/${x.id}/run-now`, { method: "POST" }), "Run started")}><Play className="h-3.5 w-3.5" />Run now</button>
                {x.webhook_url && <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => act(async () => { const r = await api<Json>(`/api/schedules/${x.id}/test-webhook`, { method: "POST" }); if (r.error) throw new Error(`Webhook: ${r.error}`); }, "Test notification delivered")}><Send className="h-3.5 w-3.5" />Test</button>}
                <button className="btn-ghost p-1.5 text-bad" onClick={() => act(() => api(`/api/schedules/${x.id}`, { method: "DELETE" }), "Schedule deleted")} aria-label="Delete schedule"><Trash2 className="h-4 w-4" /></button>
              </div>}
            </div>
          </Card>))}</div>
      )}
      <CreateSchedule open={create} onClose={() => setCreate(false)} onDone={() => { setCreate(false); s.reload(); }} />
    </div>
  );
}

function CreateSchedule({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const suites = useApi<Json[]>(open ? "/api/suites" : null), agents = useApi<Json[]>(open ? "/api/agents" : null);
  const [f, setF] = useState({ suiteId: 0, agentId: 0, interval: 360, webhookUrl: "", notify: "failures" });
  const [busy, setBusy] = useState(false); const toast = useToast();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api("/api/schedules", { method: "POST", json: { suiteId: f.suiteId || suites.data?.[0]?.id, agentId: f.agentId || agents.data?.[0]?.id, intervalMinutes: f.interval, webhookUrl: f.webhookUrl || null, notify: f.notify } }); toast("Schedule created", "ok"); onDone(); }
    catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New schedule">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Suite</span><select className="input" value={f.suiteId} onChange={(e) => setF({ ...f, suiteId: Number(e.target.value) })}>{suites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="block"><span className="label">Agent</span><select className="input" value={f.agentId} onChange={(e) => setF({ ...f, agentId: Number(e.target.value) })}>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        </div>
        <label className="block"><span className="label">Every</span><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: Number(e.target.value) })}>{[[15, "15 minutes"], [60, "hour"], [360, "6 hours"], [1440, "day"], [10080, "week"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="block"><span className="label">Webhook URL (Slack incoming webhook or any JSON endpoint)</span><input className="input mono" type="url" placeholder="https://hooks.slack.com/services/…" value={f.webhookUrl} onChange={(e) => setF({ ...f, webhookUrl: e.target.value })} /></label>
        <label className="block"><span className="label">Notify on</span><select className="input" value={f.notify} onChange={(e) => setF({ ...f, notify: e.target.value })}><option value="failures">Gate failures only</option><option value="always">Every run</option><option value="never">Never</option></select></label>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy && <Spinner />}Create</button></div>
      </form>
    </Modal>
  );
}
