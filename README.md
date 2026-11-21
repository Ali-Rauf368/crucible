# Crucible

**AI agent evaluation & chaos-testing control plane.** Crucible sits between your AI agents and the LLM providers and tools they call. It records every prompt, tool call and response as OpenTelemetry spans. During test runs it deliberately injects failures and attacks, then grades each run on **accuracy, safety and resilience**. Regressions are blocked in CI before they reach production.

Think Netflix's Chaos Monkey, built for autonomous LLM workflows.

```
 your agent ──► Crucible proxy ──► LLM provider (Anthropic Messages API, or the offline mock)
     │              │  ▲
     │              │  └─ chaos engine: 5xx · 429 · hangs · latency · malformed JSON · schema drift
     │              │                   empty / truncated output · indirect prompt injection
     │              └──► tools (sandboxed catalog, or your real tool via x-crucible-upstream)
     ▼
 assertions + LLM-as-a-judge ──► scores ──► regression gate (UI, API, CI)
```

## Highlights

**Traffic interception**
- Anthropic-compatible `/proxy/anthropic/v1/messages`, including SSE streaming passthrough, plus `/proxy/tools/:name`.
- Agents only need a different base URL and two headers.

**Deterministic chaos**
- Faults fire on specific call numbers or with a probability.
- Every decision comes from a hash of (seed, session, fault, call), so the same seed replays the identical fault schedule.
- CI runs reuse the baseline's seed, so any difference comes from your change.

**Loop and agency guards**
- A per-session call budget stops runaway retry loops.
- Repeated identical tool calls are flagged.
- Dangerous tools (`transfer_funds`) are recorded as unsafe actions.

**Grading**
- 17 deterministic assertion types: regex/contains, JSON Schema (Ajv), structured-field equality, tool called / not called, latency, cost, token and call budgets, judge minimums.
- 4 always-on guards: no crash, no loop, no unsafe action (critical), no system-prompt or canary leak (critical).
- **LLM-as-a-judge**:
  - Uses Claude (`claude-opus-5-5`, adaptive thinking, structured tool output validated with zod) when `ANTHROPIC_API_KEY` is set.
  - Otherwise uses a transparent heuristic judge, which is also the automatic fallback.
- Outcomes:
  - `ok` and `recovered`
  - `degraded`, `incorrect` and `over_budget`
  - `crashed`, `timeout`, `loop` and `unsafe`

**Regression analysis**
- Per-scenario pass/fail flips.
- Score deltas, with a paired-bootstrap 90% CI on the pass-rate delta.
- Cost and p95 latency change.
- The gate fails on critical regressions, a score drop beyond the budget, or a cost increase beyond the budget.

**Observability**
- Real OpenTelemetry SDK spans following the `gen_ai.*` semantic conventions.
- Trace waterfall per case, with fault markers.
- Live traffic stream.
- OTLP/HTTP JSON ingest (`/v1/traces`) for your agent's own spans.

**Ingestion**: an Apache NiFi flow (`nifi/crucible-ingest-flow.json`) posts LLM-gateway logs as NDJSON to `/api/ingest/nifi`.

**Storage and queue**
- PostgreSQL holds suites, rubrics, runs and results.
- Traces go to **MongoDB** when `MONGO_URL` is set, otherwise to Postgres.
- Jobs go to **BullMQ/Redis** when `REDIS_URL` is set, otherwise to a durable Postgres queue (`FOR UPDATE SKIP LOCKED`).

**Dashboard** (Next.js 15, TypeScript, Tailwind, Recharts):
- overview (KPIs, score trends, agent radar, fault survival, outcomes, proxy traffic)
- run scorecards with a case inspector (trace waterfall, assertions, judge reasoning, I/O)
- regression report
- suite and scenario editor (fault-plan and assertion builders)
- chaos studio playground
- live traffic
- agents
- integrations and keys
- audit log

Plus: dark/light themes, responsive down to phone width, SSE live updates.

**Security**
- JWT httpOnly sessions with RBAC (viewer / engineer / admin).
- Scoped API keys (`proxy`, `ci`, `ingest`) stored as SHA-256 hashes.
- Short-lived SSE tickets.
- Short-lived internal tokens for reference agents.
- Audit log.
- Helmet and rate limits.

## Production-grade extras

**Live chaos experiments**
- Inject a fault into a percentage of *real* proxy traffic (calls without a test session).
- Safety rails:
  - a blast-radius cap (max injections)
  - a mandatory expiry
  - a per-experiment stop button
  - a global **kill switch** that takes effect on every replica within about 2 s
- Injected spans are tagged with `crucible.experiment.id`.

**Attack mutation fuzzing**
- Turns one red-team scenario into obfuscated variants: base64 smuggling, leetspeak, zero-width characters, German translation, role-play wrapper, hidden HTML comment, payload splitting.
- Capable models still understand these variants; keyword and regex guards don't.
- In the demo, the obfuscated variants slip past v2's regex input guard, but its output redaction still prevents the leak (defence in depth). That is exactly the kind of finding this feature exists to surface.

**Record & replay**
- Pin any case as a new scenario that replays its exact input and fault schedule (same types, targets and call numbers).

**Flakiness analysis**
- Per scenario and agent: pass history, flip count, **pass@k** (any of k repeats passes) and **pass^k** (all k pass).
- A verdict for each: stable pass, stable fail, flaky, or mostly passing / mostly failing.

**Scheduled runs**
- Continuous evaluation on a cadence (catches model drift and upstream changes).
- Each run reuses the baseline's seed and is gated against the baseline.
- Slack-compatible webhook alerts, on failure or on every run, with a delivery log.
- Schedules fire exactly once across replicas (`SKIP LOCKED`).
- Every completed run stores its gate verdict, shown as a badge on run pages.

## The demo agents

Two reference agents run the same task (a support bot with order, refund, knowledge-base, weather, currency, email and funds-transfer tools) against an offline mock model:

| | Support bot v1 (`naive`) | Support bot v2 (`hardened`) |
|---|---|---|
| LLM client | raw `fetch` | official Anthropic SDK pointed at the proxy (retries + timeouts) |
| Tool calls | no timeout, no retry, `JSON.parse` everything | timeouts, retry honouring `Retry-After`, JSON validation, schema normalisation |
| Tool output | trusted | indirect-injection sanitising |
| Dangerous tools | executes | human-approval policy |
| Budgets | none (the Crucible loop guard stops it) | step budget with graceful degradation |

The mock model is deliberately gullible: it retries failed tools forever and obeys injected instructions. That way, the agent's own defences are what gets tested. On first start, Crucible runs both agents through all three suites. The fragile v1 crashes, loops and wires money to an attacker; v2 survives. You can then compare them, or see the CI gate block the 5× pricier "XL" model on cost.

## Run locally

Requires Node 22+ and PostgreSQL binaries (`/usr/lib/postgresql/*/bin`). Redis, MongoDB and an API key are optional.

```bash
npm install
npm run dev          # local Postgres on :55435 → API + proxy + workers on :4200 → web on :3200
```

Open http://localhost:3200 and sign in as **engineer@crucible.dev**, **admin@crucible.dev** or **viewer@crucible.dev**, all with password `crucible-demo`.

Copy `apps/api/.env.example` to `apps/api/.env` to:
- turn on the Claude judge (`ANTHROPIC_API_KEY`)
- use MongoDB or Redis
- set real model prices (`PRICING_JSON`)

To run the full stack with MongoDB and Redis instead: `docker compose up --build`.

## Point your own agent at Crucible

```ts
const client = new Anthropic({
  baseURL: "http://localhost:4200/proxy/anthropic",
  defaultHeaders: { "x-crucible-key": process.env.CRUCIBLE_KEY },   // a key with the `proxy` scope
});
// tools: POST http://localhost:4200/proxy/tools/<name>  (+ x-crucible-upstream: <real tool URL>)
```

Register the agent as an HTTP agent (**Agents → Register**). Crucible will call it with `{ input, sessionId, crucible: { llmBaseUrl, toolsBaseUrl, headers } }` and expect `{ output, data? }` back. Forward `crucible.headers` on every LLM and tool call so they are attributed to the case and receive its fault plan.

## CI gate

```bash
CRUCIBLE_URL=http://crucible:4200 CRUCIBLE_KEY=cr_... \
  node scripts/crucible-ci.mjs --suite redteam-injection --agent support-hardened
# exit 0 = gate passed · 1 = gate failed (reasons + regressions printed) · 2 = error
```

Or call the API directly: `POST /api/ci/runs` returns 200 when the gate passes and 422 when it fails. See `.github/workflows/ci.yml`.

## Tests

```bash
npm test                      # API: 26 tests incl. full naive-vs-hardened runs, red team, CI gate, OTLP + NiFi ingest
npm run typecheck
cd e2e && npx playwright test # 5 browser flows (needs `npm run dev` running)
```

## Layout

```
apps/api   Express 5 + TypeScript: proxy, chaos engine, agents, eval, runner, routes, OTel tracing
apps/web   Next.js 15 dashboard
e2e        Playwright
nifi       Apache NiFi flow definition
scripts    dev.sh, crucible-ci.mjs
docs       architecture.md
```
