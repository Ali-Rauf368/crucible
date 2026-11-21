"use client";
import { useEffect, useState } from "react";
import { Plug, KeyRound, Copy, Check, GitBranch, Database, Workflow, Radio, Trash2, Scale } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { ago } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, Skeleton, Modal, Spinner, Tabs, useToast } from "@/components/ui";
import { useSession, can } from "@/components/shell";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const snippets = (base: string) => ({
  proxy: `import Anthropic from "@anthropic-ai/sdk";

// Route your agent's LLM traffic through Crucible (no other code changes)
const client = new Anthropic({
  baseURL: "${base}/proxy/anthropic",
  defaultHeaders: { "x-crucible-key": process.env.CRUCIBLE_KEY },
});

// Tools: POST ${base}/proxy/tools/<name>   (x-crucible-upstream: <your real tool URL>)`,
  ci: `# .github/workflows/agent-evals.yml
- name: Crucible regression gate
  run: node scripts/crucible-ci.mjs --suite support-resilience --agent support-hardened
  env:
    CRUCIBLE_URL: ${base}
    CRUCIBLE_KEY: \${{ secrets.CRUCIBLE_KEY }}
    GIT_SHA: \${{ github.sha }}
# exits 1 when the gate fails (critical regressions, score drop, cost increase)`,
  curl: `curl -sf -X POST ${base}/api/ci/runs \\
  -H "x-api-key: $CRUCIBLE_KEY" -H "content-type: application/json" \\
  -d '{"suite":"redteam-injection","agent":"support-hardened","gitSha":"'$GIT_SHA'"}'
# 200 = gate passed · 422 = gate failed (body lists reasons and regressions)`,
  otlp: `# Send your agent's own OpenTelemetry spans (OTLP/HTTP JSON)
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<ingest key>
OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
  nifi: `Apache NiFi → Crucible (LLM gateway logs)
  ListenHTTP / ConsumeKafka / TailFile
    → JoltTransformJSON  (map fields to: source, kind, model, tool, latency_ms,
                          input_tokens, output_tokens, status, prompt, session_id)
    → MergeRecord        (NDJSON, ≤ 5000 records)
    → InvokeHTTP  POST ${base}/api/ingest/nifi
                  Content-Type: application/x-ndjson
                  x-api-key: <ingest key>
Template: nifi/crucible-ingest-flow.json`,
});

export default function Integrations() {
  const x = useApi<Json>("/api/integrations");
  const user = useSession(); const toast = useToast();
  const [tab, setTab] = useState<"proxy" | "ci" | "curl" | "otlp" | "nifi">("proxy");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState(""); const [scopes, setScopes] = useState(["proxy", "ci", "ingest"]);
  const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  const [base, setBase] = useState("http://localhost:4200");
  useEffect(() => { if (x.data?.proxyBase) setBase(x.data.proxyBase.replace("127.0.0.1", "localhost")); }, [x.data]);
  if (!x.data) return <Skeleton className="h-96" />;
  const create = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); try { const k = await api<Json>("/api/keys", { method: "POST", json: { name, scopes } }); setNewKey(k.key); setName(""); x.reload(); } catch (err) { toast((err as Error).message, "bad"); } finally { setBusy(false); } };
  const copy = (t: string) => { navigator.clipboard?.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const sn = snippets(base);

  return (
    <div className="space-y-5">
      <PageHeader title="Integrations & CI" subtitle="Wire Crucible into your agents, your pipeline and your telemetry." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[[Database, "Trace store", x.data.traceStore === "mongodb" ? "MongoDB" : "PostgreSQL", x.data.mongo ? "MONGO_URL set" : "set MONGO_URL to use MongoDB"], [Workflow, "Job queue", x.data.queue.backend === "bullmq" ? "BullMQ · Redis" : "PostgreSQL (SKIP LOCKED)", `${x.data.queue.active ?? 0} active · ${x.data.queue.waiting ?? 0} waiting`], [Scale, "LLM judge", x.data.judge === "claude" ? "Claude" : "Heuristic", x.data.judgeModel ?? "set ANTHROPIC_API_KEY for Claude"], [Radio, "Upstream", x.data.upstreamKey ? "Anthropic key configured" : "Mock provider only", "crucible-mock-* models always available"]].map(([Icon, l, v, h]) => {
          const I = Icon as typeof Plug;
          return <Card key={l as string} className="card-pad"><p className="flex items-center gap-1.5 text-xs text-muted"><I className="h-3.5 w-3.5 text-accent" />{l as string}</p><p className="mt-1 font-semibold">{v as string}</p><p className="mt-0.5 text-[11px] text-subtle">{h as string}</p></Card>;
        })}
      </div>
      <div className="grid gap-5 xl:grid-cols-5 [&>*]:min-w-0">
        <Card className="card-pad xl:col-span-3">
          <CardHeader title="Connect" icon={Plug} action={<Tabs value={tab} onChange={setTab} options={[{ value: "proxy", label: "Proxy" }, { value: "ci", label: "GitHub Actions" }, { value: "curl", label: "CI API" }, { value: "otlp", label: "OTLP" }, { value: "nifi", label: "NiFi" }]} />} />
          <div className="relative"><pre className="max-h-96 overflow-auto rounded-lg border border-line bg-bg p-4 text-xs leading-5 mono">{sn[tab]}</pre><button className="btn-ghost absolute right-2 top-2 p-1.5" onClick={() => copy(sn[tab])} aria-label="Copy snippet">{copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}</button></div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><GitBranch className="h-3.5 w-3.5" />CI runs reuse the baseline&apos;s seed, so the candidate faces the identical fault schedule.</p>
        </Card>
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="API keys" subtitle="Scoped: proxy · ci · ingest. Stored as SHA-256 hashes." icon={KeyRound} />
          {can(user, "admin") && (
            <form onSubmit={create} className="mb-4 space-y-2">
              <div className="flex gap-2"><input className="input" placeholder="Key name, e.g. github-actions" value={name} onChange={(e) => setName(e.target.value)} minLength={2} required /><button className="btn-primary shrink-0" disabled={busy}>{busy && <Spinner />}Create</button></div>
              <div className="flex gap-3 text-xs">{["proxy", "ci", "ingest"].map((s) => <label key={s} className="flex items-center gap-1.5"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((y) => y !== s))} />{s}</label>)}</div>
            </form>
          )}
          <ul className="space-y-2">{x.data.keys.map((k: Json) => (
            <li key={k.id} className="flex items-center gap-2 rounded-lg border border-line p-2.5 text-sm">
              <div className="min-w-0 flex-1"><p className="font-medium">{k.name} {k.revoked_at && <Badge tone="bad">revoked</Badge>}</p><p className="text-xs text-subtle mono">{k.preview} · {k.scopes.join(", ")} · {k.last_used_at ? `used ${ago(k.last_used_at)}` : "never used"}</p></div>
              {can(user, "admin") && !k.revoked_at && <button className="btn-ghost p-1.5 text-bad" onClick={async () => { await api(`/api/keys/${k.id}`, { method: "DELETE" }); x.reload(); }} aria-label={`Revoke ${k.name}`}><Trash2 className="h-4 w-4" /></button>}
            </li>))}{!x.data.keys.length && <p className="text-sm text-muted">No keys yet.</p>}</ul>
        </Card>
      </div>
      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="Copy your new key now">
        <p className="mb-3 text-sm text-muted">It won&apos;t be shown again.</p>
        <div className="flex gap-2"><code className="input select-all break-all text-xs mono">{newKey}</code><button className="btn-secondary" onClick={() => copy(newKey ?? "")} aria-label="Copy key">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</button></div>
      </Modal>
    </div>
  );
}
