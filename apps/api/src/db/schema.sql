-- Crucible schema (idempotent). Postgres holds configuration, results and (by default) traces.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','engineer','admin')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  preview TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{proxy,ci,ingest}',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An agent under test: a built-in reference agent or any HTTP endpoint implementing the Crucible agent contract.
CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('builtin','http')),
  endpoint TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suites (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rubric TEXT NOT NULL DEFAULT '',
  -- pass gate for the suite and CI regression budget
  thresholds JSONB NOT NULL DEFAULT '{"overall":0.7,"maxRegression":0.05,"maxCostIncreasePct":25}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenarios (
  id SERIAL PRIMARY KEY,
  suite_id INT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'functional',
  input TEXT NOT NULL,
  expected TEXT NOT NULL DEFAULT '',
  assertions JSONB NOT NULL DEFAULT '[]',
  faults JSONB NOT NULL DEFAULT '[]',
  tags TEXT[] NOT NULL DEFAULT '{}',
  critical BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_suite ON scenarios (suite_id);

CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  suite_id INT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  trigger TEXT NOT NULL DEFAULT 'manual',
  git_sha TEXT,
  seed INT NOT NULL,
  repeats INT NOT NULL DEFAULT 1,
  chaos BOOLEAN NOT NULL DEFAULT true,
  is_baseline BOOLEAN NOT NULL DEFAULT false,
  total INT NOT NULL DEFAULT 0,
  done INT NOT NULL DEFAULT 0,
  scores JSONB,
  summary JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_suite ON runs (suite_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_cases (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scenario_id INT REFERENCES scenarios(id) ON DELETE SET NULL,
  scenario_name TEXT NOT NULL,
  category TEXT NOT NULL,
  critical BOOLEAN NOT NULL DEFAULT false,
  attempt INT NOT NULL DEFAULT 1,
  session_id TEXT UNIQUE NOT NULL,
  trace_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','errored')),
  passed BOOLEAN,
  outcome TEXT,              -- ok | recovered | degraded | crashed | loop | timeout | unsafe
  output TEXT,
  error TEXT,
  scores JSONB,
  assertions JSONB,
  judge JSONB,
  faults_planned JSONB NOT NULL DEFAULT '[]',
  faults_injected JSONB NOT NULL DEFAULT '[]',
  llm_calls INT NOT NULL DEFAULT 0,
  tool_calls INT NOT NULL DEFAULT 0,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms INT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS run_cases_run ON run_cases (run_id);

-- Default trace store (MongoDB is used instead when MONGO_URL is set). OTel-shaped spans.
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  session_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT 'crucible',
  start_time TIMESTAMPTZ NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  attributes JSONB NOT NULL DEFAULT '{}',
  events JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS spans_trace ON spans (trace_id, start_time);
CREATE INDEX IF NOT EXISTS spans_session ON spans (session_id, start_time);
CREATE INDEX IF NOT EXISTS spans_time ON spans (start_time DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (queue, run_at) WHERE status = 'waiting';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs (queue, dedupe_key) WHERE status IN ('waiting','active') AND dedupe_key IS NOT NULL;

ALTER TABLE run_cases ADD COLUMN IF NOT EXISTS root_span_id TEXT;
ALTER TABLE run_cases ADD COLUMN IF NOT EXISTS call_counts JSONB NOT NULL DEFAULT '{}';
ALTER TABLE run_cases ADD COLUMN IF NOT EXISTS loop_detected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE run_cases ADD COLUMN IF NOT EXISTS unsafe_actions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE run_cases ADD COLUMN IF NOT EXISTS data JSONB;

-- Live chaos experiments on real (non-test) proxy traffic
CREATE TABLE IF NOT EXISTS experiments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  fault JSONB NOT NULL,
  traffic_pct DOUBLE PRECISION NOT NULL CHECK (traffic_pct > 0 AND traffic_pct <= 100),
  max_injections INT NOT NULL DEFAULT 100,
  injected INT NOT NULL DEFAULT 0,
  eligible INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','completed')),
  stop_reason TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ
);

-- Scheduled evaluation runs with webhook alerts
CREATE TABLE IF NOT EXISTS schedules (
  id SERIAL PRIMARY KEY,
  suite_id INT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  interval_minutes INT NOT NULL CHECK (interval_minutes BETWEEN 5 AND 10080),
  webhook_url TEXT,
  notify TEXT NOT NULL DEFAULT 'failures' CHECK (notify IN ('failures','always','never')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_id INT REFERENCES runs(id) ON DELETE SET NULL,
  last_status TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS schedule_id INT REFERENCES schedules(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS gate JSONB;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  schedule_id INT REFERENCES schedules(id) ON DELETE CASCADE,
  run_id INT REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status INT,
  error TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS source JSONB;
