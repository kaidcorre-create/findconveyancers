-- ConveySelect D1 Schema

-- ── Leads ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  agent_ref         TEXT NOT NULL DEFAULT 'direct',
  agent_name        TEXT NOT NULL DEFAULT 'Direct',

  -- Property info
  transaction_types TEXT NOT NULL DEFAULT '[]',  -- JSON array: ["buy","sell"]
  property_type     TEXT NOT NULL DEFAULT '',     -- freehold / leasehold
  property_value    INTEGER NOT NULL DEFAULT 0,
  postcode          TEXT NOT NULL DEFAULT '',
  timeline          TEXT NOT NULL DEFAULT '',

  -- Contact
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT NOT NULL,

  -- CRM
  status            TEXT NOT NULL DEFAULT 'new',  -- new/contacted/converted/lost
  notes             TEXT NOT NULL DEFAULT '',
  assigned_to       TEXT NOT NULL DEFAULT '',     -- conveyancer firm name

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ── Agents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,   -- used in URL ?ref=
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  fee_per_lead  INTEGER NOT NULL DEFAULT 0,  -- pence
  created_at    TEXT NOT NULL
);

-- ── Conveyancers ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conveyancers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  regions      TEXT NOT NULL DEFAULT '[]',  -- JSON array of postcodes/regions
  active       INTEGER NOT NULL DEFAULT 1,
  fee_per_lead INTEGER NOT NULL DEFAULT 0,  -- pence, what they pay you
  created_at   TEXT NOT NULL
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_agent_ref  ON leads(agent_ref);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_postcode   ON leads(postcode);
CREATE INDEX IF NOT EXISTS idx_agents_ref       ON agents(ref);
