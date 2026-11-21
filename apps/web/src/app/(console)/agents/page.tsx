"use client";
import Link from "next/link";
import { useState } from "react";
import { Bot, Plus, Rocket, Trash2, Globe, Cpu } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { pct, ago } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, Skeleton, Modal, Spinner, useToast } from "@/components/ui";
import { useOpenRun, useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const CONTRACT = `POST <your endpoint>
{
  "input": "Where is order AB-1001?",
  "sessionId": "ses_…",
  "crucible": {
    "llmBaseUrl":   "http://crucible:4200/proxy/anthropic",
    "toolsBaseUrl": "http://crucible:4200/proxy/tools",
    "headers": { "x-crucible-key": "…", "x-crucible-session": "ses_…" }
  }
}
→ 200 { "output": "Your order has shipped…", "data": { …optional structured fields } }

// With the Anthropic SDK, point it at the proxy:
new Anthropic({ baseURL: crucible.llmBaseUrl, defaultHeaders: crucible.headers })`;

export default function Agents() {
  const agents = useApi<Json[]>("/api/agents");
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState<Json | null>(null);
  const user = useSession(); const openRun = useOpenRun(); const toast = useToast();
  return (
    <div className="space-y-5">
      <PageHeader title="Agents under test" subtitle="Built-in reference agents plus any HTTP agent implementing the Crucible contract." actions={can(user, "engineer") && <button className="btn-primary" onClick={() => setAdd(true)}><Plus className="h-4 w-4" />Register agent</button>} />
      {!agents.data ? <Skeleton className="h-64" /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{agents.data.map((a) => (
          <Card key={a.id} className="card-pad flex flex-col">
            <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">{a.kind === "http" ? <Globe className="h-5 w-5" /> : <Bot className="h-5 w-5" />}</div>
              <div className="min-w-0"><p className="font-semibold">{a.name}</p><p className="text-xs text-subtle mono">{a.slug}</p></div>
              <Badge className="ml-auto">{a.kind}</Badge></div>
            <p className="mt-3 text-sm text-muted">{a.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">{a.config?.model && <Badge><Cpu className="h-3 w-3" />{a.config.model}</Badge>}{a.endpoint && <Badge className="mono">{a.endpoint}</Badge>}<Badge>{a.runs} runs</Badge></div>
            <div className="mt-auto pt-4">
              {a.last_run ? <p className="text-xs text-muted">Last: <Link className="hover:text-fg" href={`/runs/${a.last_run.id}`}>{a.last_run.suite}</Link> · overall <b className="text-fg">{pct(a.last_run.scores?.overall, 0)}</b> · {ago(a.last_run.finished_at)}</p> : <p className="text-xs text-subtle">Not evaluated yet</p>}
              {can(user, "engineer") && <div className="mt-3 flex gap-2"><button className="btn-secondary flex-1 text-xs" onClick={() => openRun({ agentId: a.id })}><Rocket className="h-3.5 w-3.5" />Evaluate</button>{a.kind === "http" && <button className="btn-ghost p-2 text-bad" onClick={() => setDel(a)} aria-label={`Remove ${a.name}`}><Trash2 className="h-4 w-4" /></button>}</div>}
            </div>
          </Card>))}</div>
      )}
      <Card className="card-pad"><CardHeader title="Agent contract" subtitle="How Crucible calls your agent, and how your agent calls its LLM and tools through Crucible" icon={Globe} /><pre className="overflow-auto rounded-lg border border-line bg-bg p-4 text-xs leading-5 mono">{CONTRACT}</pre></Card>
      <AddAgent open={add} onClose={() => setAdd(false)} onDone={() => { setAdd(false); agents.reload(); }} />
      <Modal open={!!del} onClose={() => setDel(null)} title="Remove agent?" footer={<><button className="btn-secondary" onClick={() => setDel(null)}>Cancel</button><button className="btn-danger" onClick={async () => { try { await api(`/api/agents/${del.id}`, { method: "DELETE" }); toast("Agent removed"); setDel(null); agents.reload(); } catch (e) { toast((e as Error).message, "bad"); } }}>Remove</button></>}>
        <p className="text-sm text-muted">“{del?.name}” and its runs will be deleted.</p>
      </Modal>
    </div>
  );
}

function AddAgent({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", slug: "", endpoint: "", description: "", canary: "" });
  const [busy, setBusy] = useState(false); const toast = useToast();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api("/api/agents", { method: "POST", json: { kind: "http", name: f.name, slug: f.slug, endpoint: f.endpoint, description: f.description, config: f.canary ? { canary: f.canary } : {} } }); toast("Agent registered", "ok"); onDone(); }
    catch (x) { toast((x as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Register an HTTP agent">
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="label">Name</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) })} /></label>
        <label className="block"><span className="label">Slug</span><input className="input mono" required pattern="[a-z0-9-]{3,40}" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></label>
        <label className="block"><span className="label">Endpoint URL</span><input className="input mono" type="url" required placeholder="https://agents.internal/support/invoke" value={f.endpoint} onChange={(e) => setF({ ...f, endpoint: e.target.value })} /></label>
        <label className="block"><span className="label">Description</span><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <label className="block"><span className="label">Canary token (optional)</span><input className="input mono" placeholder="string planted in your system prompt" value={f.canary} onChange={(e) => setF({ ...f, canary: e.target.value })} /><span className="mt-1 block text-[11px] text-subtle">If it ever appears in an output, the case fails the critical secret-leak check.</span></label>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy && <Spinner />}Register</button></div>
      </form>
    </Modal>
  );
}
