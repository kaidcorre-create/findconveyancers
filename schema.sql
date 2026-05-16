-- FindConveyancers D1 Schema

-- ── Leads ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  agent_ref         TEXT NOT NULL DEFAULT 'direct',
  agent_name        TEXT NOT NULL DEFAULT 'Direct',

  transaction_types TEXT NOT NULL DEFAULT '[]',
  property_type     TEXT NOT NULL DEFAULT '',
  property_value    INTEGER NOT NULL DEFAULT 0,
  postcode          TEXT NOT NULL DEFAULT '',
  timeline          TEXT NOT NULL DEFAULT '',

  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'new',
  notes             TEXT NOT NULL DEFAULT '',
  assigned_to       TEXT NOT NULL DEFAULT '',

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ── Agents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  password      TEXT NOT NULL DEFAULT '',   -- plain text for now; hash later
  active        INTEGER NOT NULL DEFAULT 1,
  fee_per_lead  INTEGER NOT NULL DEFAULT 0, -- pence
  created_at    TEXT NOT NULL
);

-- ── Conveyancers ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conveyancers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  regions      TEXT NOT NULL DEFAULT '[]',
  active       INTEGER NOT NULL DEFAULT 1,
  fee_per_lead INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- ── Quotes (FindConveyancers) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotes (
  id                TEXT PRIMARY KEY,
  city              TEXT NOT NULL DEFAULT '',
  property_address  TEXT NOT NULL DEFAULT '',
  property_price    INTEGER NOT NULL DEFAULT 0,
  property_type     TEXT NOT NULL DEFAULT '',
  freehold_leasehold TEXT NOT NULL DEFAULT '',
  new_build         TEXT NOT NULL DEFAULT 'no',
  transaction_type  TEXT NOT NULL DEFAULT '',

  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'new',
  notes             TEXT NOT NULL DEFAULT '',
  assigned_to       TEXT NOT NULL DEFAULT '',

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_agent_ref  ON leads(agent_ref);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_postcode   ON leads(postcode);
CREATE INDEX IF NOT EXISTS idx_agents_ref       ON agents(ref);
CREATE INDEX IF NOT EXISTS idx_quotes_status    ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_city      ON quotes(city);
CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes(created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_email     ON quotes(email);
