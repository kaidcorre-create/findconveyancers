-- FindConveyancers – Migration: Quote Management System
-- Run each statement in the Cloudflare D1 console
-- (Dashboard → D1 → conveyselect-db → Console)

-- ── 1. Conveyancer price quotes ────────────────────────────────────────────────
-- Stores the actual fee quotes that conveyancers submit for each lead
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

CREATE INDEX IF NOT EXISTS idx_cq_lead        ON conveyancer_quotes(lead_uuid);
CREATE INDEX IF NOT EXISTS idx_cq_conveyancer ON conveyancer_quotes(conveyancer_id);
CREATE INDEX IF NOT EXISTS idx_cq_chosen      ON conveyancer_quotes(chosen);

-- ── 2. New columns on leads table ─────────────────────────────────────────────
-- Track pipeline progression on each consumer lead
ALTER TABLE leads ADD COLUMN instructed_conveyancer_id TEXT DEFAULT '';
ALTER TABLE leads ADD COLUMN quotes_sent_at            TEXT DEFAULT '';
ALTER TABLE leads ADD COLUMN instructed_at             TEXT DEFAULT '';
