"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Zap, ShieldAlert, GitCompareArrows, Activity } from "lucide-react";
import { api } from "@/lib/api";
import { Spinner, cx } from "@/components/ui";

const DEMO = [["engineer@crucible.dev", "Engineer"], ["admin@crucible.dev", "Admin"], ["viewer@crucible.dev", "Viewer"]];

function LoginForm() {
  const [email, setEmail] = useState("engineer@crucible.dev");
  const [password, setPassword] = useState("crucible-demo");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("/api/auth/login", { method: "POST", json: { email, password } }); router.push(next.startsWith("/") ? next : "/"); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6 shadow-2xl">
      <div><h2 className="text-lg font-semibold">Sign in</h2><p className="text-sm text-muted">Demo accounts use the password <span className="mono">crucible-demo</span>.</p></div>
      <div className="grid grid-cols-3 gap-1.5">{DEMO.map(([e, r]) => <button type="button" key={e} onClick={() => { setEmail(e); setPassword("crucible-demo"); }} className={cx("rounded-lg border px-2 py-1.5 text-xs transition", email === e ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>{r}</button>)}</div>
      <label className="block"><span className="label">Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label className="block"><span className="label">Password</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {err && <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{err}</p>}
      <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner />}Sign in</button>
    </form>
  );
}

export default function Login() {
  return (
    <div className="ember grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between border-r border-line p-10 lg:flex">
        <div className="flex items-center gap-2.5"><img src="/favicon.svg" alt="" className="h-9 w-9" /><span className="text-lg font-semibold">Crucible</span></div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">Break your AI agents before your users do.</h1>
          <p className="mt-3 text-muted">A control plane that sits between your agents and their LLMs and tools, injects realistic failures and attacks, and grades every run for accuracy, safety and resilience.</p>
          <ul className="mt-8 space-y-3 text-sm">
            {[[Zap, "Chaos injection: 5xx, 429, hangs, malformed JSON, schema drift, truncation"], [ShieldAlert, "Prompt-injection red teaming with critical safety gates"], [Activity, "OpenTelemetry traces for every LLM and tool call"], [GitCompareArrows, "Regression gates for prompt and model changes in CI"]].map(([Icon, t], i) => {
              const I = Icon as typeof Zap;
              return <li key={i} className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent"><I className="h-4 w-4" /></span><span className="pt-1 text-muted">{t as string}</span></li>;
            })}
          </ul>
        </div>
        <p className="text-xs text-subtle">Netflix-style chaos engineering, built for autonomous LLM workflows.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden"><img src="/favicon.svg" alt="" className="h-9 w-9" /><span className="text-lg font-semibold">Crucible</span></div>
          <Suspense fallback={<Spinner />}><LoginForm /></Suspense>
        </div>
      </div>
    </div>
  );
}
