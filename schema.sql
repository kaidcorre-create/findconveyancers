-- FindConveyancers D1 Schema

-- ── Leads ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  agent_ref         TEXT NOT NULL DEFAULT 'direct',
  agent_name        TEXT NOT NULL DEFAULT 'Direct',

  transaction_types TEXT NOT NULL DEFAULT '[]',
  property_type     TEXT NOT NULL DEFAULT '',
  property_value    INTEGER NOT NULL DEFAULT 0,
  property_address  TEXT NOT NULL DEFAULT '',
  freehold_leasehold TEXT NOT NULL DEFAULT '',
  new_build         TEXT NOT NULL DEFAULT 'no',
  postcode          TEXT NOT NULL DEFAULT '',
  timeline          TEXT NOT NULL DEFAULT '',

  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'new',
  notes             TEXT NOT NULL DEFAULT '',
  assigned_to       TEXT NOT NULL DEFAULT '',

  -- pipeline tracking (originally added via schema_migration.sql)
  instructed_conveyancer_id TEXT NOT NULL DEFAULT '',
  quotes_sent_at            TEXT NOT NULL DEFAULT '',
  instructed_at             TEXT NOT NULL DEFAULT '',

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

-- ── Conveyancer price quotes ───────────────────────────────────────────────
-- The actual fee quotes that conveyancers submit against each lead.
CREATE TABLE IF NOT EXISTS conveyancer_quotes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_uuid       TEXT    NOT NULL,  -- references leads.id
  conveyancer_id  TEXT    NOT NULL,  -- references conveyancers.id

  legal_fee       INTEGER NOT NULL DEFAULT 0,  -- pence, ex-VAT
  vat_amount      INTEGER NOT NULL DEFAULT 0,  -- pence (20%)
  searches        INTEGER NOT NULL DEFAULT 0,  -- pence
  land_registry   INTEGER NOT NULL DEFAULT 0,  -- pence
  other_fees      INTEGER NOT NULL DEFAULT 0,  -- pence
  disbursements   INTEGER NOT NULL DEFAULT 0,  -- pence (searches + land_reg + other)
  total_quote     INTEGER NOT NULL DEFAULT 0,  -- pence (legal + vat + disbursements)

  breakdown_text  TEXT    NOT NULL DEFAULT '',
  submitted_at    TEXT    NOT NULL DEFAULT '',
  chosen          INTEGER NOT NULL DEFAULT 0   -- 1 when consumer selects this firm
);

-- ── Page Events (funnel tracking) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_page_events_event ON page_events(event);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_agent_ref  ON leads(agent_ref);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_postcode   ON leads(postcode);
CREATE INDEX IF NOT EXISTS idx_agents_ref       ON agents(ref);
CREATE INDEX IF NOT EXISTS idx_cq_lead          ON conveyancer_quotes(lead_uuid);
CREATE INDEX IF NOT EXISTS idx_cq_conveyancer   ON conveyancer_quotes(conveyancer_id);
CREATE INDEX IF NOT EXISTS idx_cq_chosen        ON conveyancer_quotes(chosen);
