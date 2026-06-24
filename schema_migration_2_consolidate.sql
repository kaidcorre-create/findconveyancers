-- FindConveyancers – Migration 2: consolidate `quotes` into `leads`
--
-- Run in the Cloudflare D1 console (Dashboard → D1 → findconveyancers-db → Console),
-- one statement at a time, OR:
--   wrangler d1 execute findconveyancers-db --remote --file=./schema_migration_2_consolidate.sql
--
-- Background: consumer submissions were previously dual-written into BOTH
-- `leads` (pipeline/CRM) and `quotes` (property detail) under a shared id.
-- This folds the property detail into `leads` so it is the single source of
-- truth, then (last step) drops the redundant `quotes` table.
--
-- ORDER OF OPERATIONS:
--   1. Run steps 1–2 below (additive + backfill — safe).
--   2. Deploy the updated worker (wrangler deploy).
--   3. Submit one real test quote and confirm it appears in `leads`.
--   4. Run the step-3 safety checks, then the step-4 DROP.

-- ── 1. Add the property-detail columns that only existed on `quotes` ──────────
ALTER TABLE leads ADD COLUMN property_address   TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN freehold_leasehold TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN new_build          TEXT NOT NULL DEFAULT 'no';

-- ── 2. Backfill from the matching `quotes` row (same id) ─────────────────────
UPDATE leads
SET property_address   = COALESCE((SELECT q.property_address   FROM quotes q WHERE q.id = leads.id), ''),
    freehold_leasehold = COALESCE((SELECT q.freehold_leasehold FROM quotes q WHERE q.id = leads.id), ''),
    new_build          = COALESCE((SELECT q.new_build          FROM quotes q WHERE q.id = leads.id), 'no')
WHERE EXISTS (SELECT 1 FROM quotes q WHERE q.id = leads.id);

-- ── 3. Safety checks — run before dropping, both should return 0 ──────────────
--   Orphan quotes (a quote with no matching lead — would be lost on DROP):
--     SELECT COUNT(*) AS orphan_quotes FROM quotes q
--     WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = q.id);
--   Addresses that failed to copy across:
--     SELECT COUNT(*) AS missing_address FROM quotes q
--     JOIN leads l ON l.id = q.id
--     WHERE q.property_address <> '' AND l.property_address = '';
--
--   If orphan_quotes > 0, promote those rows into `leads` first:
--     INSERT INTO leads (
--       id, agent_ref, agent_name, transaction_types, property_type,
--       property_value, property_address, freehold_leasehold, new_build,
--       postcode, timeline, first_name, last_name, email, phone,
--       status, notes, assigned_to, created_at, updated_at,
--       instructed_conveyancer_id, quotes_sent_at, instructed_at)
--     SELECT
--       q.id, 'findconveyancers', 'FindConveyancers',
--       json_array(q.transaction_type), q.property_type, q.property_price,
--       q.property_address, q.freehold_leasehold, q.new_build,
--       COALESCE(NULLIF(q.city,''),'UK'), '', q.first_name, q.last_name,
--       q.email, q.phone, q.status, '', '', q.created_at, q.updated_at,
--       '', '', ''
--     FROM quotes q
--     WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = q.id);

-- ── 4. Drop the redundant table ──────────────────────────────────────────────
-- ⚠️  Run ONLY after deploying the worker and confirming a fresh test
--     submission lands in `leads`. Uncomment to execute:
-- DROP TABLE quotes;
