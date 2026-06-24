/**
 * FindConveyancers: Cloudflare Worker
 * Handles: lead submission, quote management, instruction flow, admin, agents
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Public ─────────────────────────────────────────────────────────────
      if (path === '/api/leads' && request.method === 'POST')
        return handleLeadSubmission(request, env);

      if (path === '/api/lead' && request.method === 'GET')
        return handleGetLead(request, env);

      if (path === '/api/quotes' && request.method === 'GET')
        return handleGetQuotes(request, env);

      if (path === '/api/quote/submit' && request.method === 'POST')
        return handleQuoteSubmit(request, env);

      if (path === '/api/instruct' && request.method === 'POST')
        return handleInstruct(request, env);

      if (path === '/api/track' && request.method === 'POST')
        return handleTrack(request, env);

      if (path === '/api/conveyancer/signup' && request.method === 'POST')
        return handleConveyancerSignup(request, env);

      if (path === '/api/estate-agent/signup' && request.method === 'POST')
        return handleEstateAgentSignup(request, env);

      // ── Admin ───────────────────────────────────────────────────────────────
      if (path === '/api/admin/login' && request.method === 'POST')
        return handleAdminLogin(request, env);

      if (path === '/api/admin/leads' && request.method === 'GET')
        return handleGetLeads(request, env);

      if (path.startsWith('/api/admin/leads/') && path.endsWith('/assign') && request.method === 'POST')
        return handleAssignLead(request, env, path.split('/')[4]);

      if (path.startsWith('/api/admin/leads/') && request.method === 'PATCH')
        return handleUpdateLead(request, env, path.split('/').pop());

      if (path === '/api/admin/stats' && request.method === 'GET')
        return handleGetStats(request, env);

      if (path === '/api/admin/conveyancers' && request.method === 'GET')
        return handleGetConveyancers(request, env);

      if (path === '/api/admin/conveyancers' && request.method === 'POST')
        return handleAddConveyancer(request, env);

      if (path.startsWith('/api/admin/conveyancers/') && request.method === 'PATCH')
        return handlePatchConveyancer(path, request, env);

      if (path === '/api/admin/agents' && request.method === 'GET')
        return handleGetAgents(request, env);

      if (path === '/api/admin/agents' && request.method === 'POST')
        return handleAddAgent(request, env);

      if (path === '/api/admin/send-partner-summary' && request.method === 'POST')
        return handleSendPartnerSummary(request, env);

      if (path === '/api/admin/preview-emails' && request.method === 'POST')
        return handlePreviewEmails(request, env);

      // ── Agent ───────────────────────────────────────────────────────────────
      if (path === '/api/agent/login' && request.method === 'POST')
        return handleAgentLogin(request, env);

      if (path === '/api/agent/me' && request.method === 'GET')
        return handleAgentMe(request, env);

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};

// ── Consumer lead submission ───────────────────────────────────────────────────
async function handleLeadSubmission(request, env) {
  const url  = new URL(request.url);
  const body = await request.json();

  const required = ['firstName', 'lastName', 'email', 'phone'];
  for (const field of required) {
    if (!body[field]) return jsonResponse({ error: `Missing field: ${field}` }, 400);
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  // Referral attribution: ?ref=<agentId> (or body.ref) links the lead to an
  // estate-agent partner. Falls back to a direct FindConveyancers submission.
  const ref = (url.searchParams.get('ref') || body.ref || '').trim();
  let agent = null;
  if (ref) {
    agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ? OR ref = ?').bind(ref, ref).first();
  }
  const agentRef  = agent ? agent.ref  : 'findconveyancers';
  const agentName = agent ? agent.name : 'FindConveyancers';

  // Save the consumer lead, single source of truth (was previously
  // dual-written into a separate `quotes` table; now consolidated here).
  await env.DB.prepare(`
    INSERT INTO leads (
      id, agent_ref, agent_name,
      transaction_types, property_type, property_value,
      property_address, freehold_leasehold, new_build,
      postcode, timeline,
      first_name, last_name, email, phone,
      status, created_at, updated_at,
      instructed_conveyancer_id, quotes_sent_at, instructed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, '', '', '')
  `).bind(
    id,
    agentRef,
    agentName,
    JSON.stringify(body.transactionTypes || [body.transactionType] || []),
    body.propertyType  || '',
    body.propertyValue || 0,
    body.propertyAddress || '',
    body.freehold || '',
    body.newBuild || 'no',
    body.city || body.postcode || 'UK',
    body.timeline  || '',
    body.firstName, body.lastName,
    body.email.toLowerCase(), body.phone,
    now, now
  ).run();

  // Email conveyancers, admin, confirm to client, and notify the referring agent.
  // Email failures must never break the API response.
  try {
    const leadRow = {
      id, first_name: body.firstName, last_name: body.lastName,
      property_address: body.propertyAddress || '', postcode: body.city || body.postcode || 'UK',
    };
    await Promise.all([
      emailConveyancers(body, id, env),
      sendEmail(env.NOTIFY_EMAIL, `New lead: ${body.firstName} ${body.lastName}`, emailAdminNewLead(body, id), env),
      sendEmail(body.email.toLowerCase(), 'Your conveyancing quote request is confirmed ✓', emailClientConfirmation(body, id), env),
      agent
        ? sendEmail(agent.email, `Your referral has entered FindConveyancers: ${body.firstName} ${body.lastName}`,
            emailEstateAgentReferralSubmitted(agent, leadRow), env, EMAIL_FROM_PARTNER)
        : Promise.resolve(),
    ]);
  } catch (e) {
    console.error('Lead-submission emails failed:', e.message);
  }

  return jsonResponse({ success: true, quoteId: id }, 201);
}

// ── Get lead details (for quote.html + compare.html) ─────────────────────────
async function handleGetLead(request, env) {
  const uuid = new URL(request.url).searchParams.get('uuid');
  if (!uuid) return jsonResponse({ error: 'Missing uuid' }, 400);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(uuid).first();
  if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

  return jsonResponse({
    id:               lead.id,
    property_address: lead.property_address || lead.postcode,
    property_value:   lead.property_value,
    property_type:    lead.property_type,
    postcode:         lead.postcode,
    first_name:       lead.first_name,
    last_name:        lead.last_name,
    status:           lead.status,
    transaction_types: JSON.parse(lead.transaction_types || '[]'),
  });
}

// ── Get conveyancer price quotes for a lead (compare.html) ───────────────────
async function handleGetQuotes(request, env) {
  const leadUuid = new URL(request.url).searchParams.get('lead');
  if (!leadUuid) return jsonResponse({ error: 'Missing lead param' }, 400);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadUuid).first();
  if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

  const { results } = await env.DB.prepare(`
    SELECT
      cq.id, cq.lead_uuid, cq.legal_fee, cq.vat_amount,
      cq.searches, cq.land_registry, cq.other_fees,
      cq.disbursements, cq.total_quote, cq.breakdown_text,
      cq.submitted_at, cq.chosen,
      c.id   AS conveyancer_id,
      c.name AS firm_name,
      c.email AS conveyancer_email,
      c.phone AS conveyancer_phone
    FROM conveyancer_quotes cq
    JOIN conveyancers c ON cq.conveyancer_id = c.id
    WHERE cq.lead_uuid = ?
    ORDER BY cq.total_quote ASC
  `).bind(leadUuid).all();

  return jsonResponse({
    quotes: results,
    lead: {
      property_address: lead.property_address || lead.postcode,
      property_value:   lead.property_value,
      first_name:       lead.first_name,
      last_name:        lead.last_name,
      status:           lead.status,
    },
  });
}

// ── Conveyancer submits a price quote ─────────────────────────────────────────
async function handleQuoteSubmit(request, env) {
  const body = await request.json();
  const { lead_uuid, conveyancer_id, legal_fee, searches, land_registry, other_fees, breakdown_text } = body;

  if (!lead_uuid || !conveyancer_id || legal_fee === undefined) {
    return jsonResponse({ error: 'Missing required fields: lead_uuid, conveyancer_id, legal_fee' }, 400);
  }

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(lead_uuid).first();
  if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

  const conveyancer = await env.DB.prepare('SELECT * FROM conveyancers WHERE id = ?').bind(conveyancer_id).first();
  if (!conveyancer) return jsonResponse({ error: 'Conveyancer not found' }, 404);

  // Prevent duplicate quotes
  const existing = await env.DB.prepare(
    'SELECT id FROM conveyancer_quotes WHERE lead_uuid = ? AND conveyancer_id = ?'
  ).bind(lead_uuid, conveyancer_id).first();
  if (existing) return jsonResponse({ error: 'Quote already submitted for this lead' }, 409);

  // Convert £ → pence
  const legalP   = Math.round(parseFloat(legal_fee)       * 100);
  const vatP     = Math.round(legalP * 0.2);
  const searchP  = Math.round(parseFloat(searches       || 0) * 100);
  const lrP      = Math.round(parseFloat(land_registry  || 0) * 100);
  const otherP   = Math.round(parseFloat(other_fees     || 0) * 100);
  const disbP    = searchP + lrP + otherP;
  const totalP   = legalP + vatP + disbP;
  const now      = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO conveyancer_quotes
    (lead_uuid, conveyancer_id, legal_fee, vat_amount, searches, land_registry,
     other_fees, disbursements, total_quote, breakdown_text, submitted_at, chosen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(lead_uuid, conveyancer_id, legalP, vatP, searchP, lrP, otherP, disbP, totalP, breakdown_text || '', now).run();

  // Count total quotes for this lead
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM conveyancer_quotes WHERE lead_uuid = ?'
  ).bind(lead_uuid).first();
  const count = row?.cnt || 0;

  const address = lead.property_address || lead.postcode;

  // Email failures must never break the API response.
  try {
    if (count >= 3 && lead.status === 'new') {
      // Enough quotes in, mark sent and email the side-by-side comparison.
      await env.DB.prepare(
        'UPDATE leads SET status = ?, quotes_sent_at = ?, updated_at = ? WHERE id = ?'
      ).bind('quotes_sent', now, now, lead_uuid).run();

      const { results: quoteRows } = await env.DB.prepare(`
        SELECT cq.total_quote, c.name AS firm_name
        FROM conveyancer_quotes cq JOIN conveyancers c ON cq.conveyancer_id = c.id
        WHERE cq.lead_uuid = ? ORDER BY cq.total_quote ASC
      `).bind(lead_uuid).all();

      await sendEmail(
        lead.email,
        'Your conveyancing quotes are ready to compare',
        emailConsumerQuotesReady(lead, address, lead_uuid, quoteRows),
        env
      );
    } else if (count === 1 && lead.status === 'new') {
      // First quote in, nudge the consumer that things are moving.
      await sendEmail(
        lead.email,
        'Your first conveyancing quote has arrived',
        emailConsumerFirstQuoteArrived(lead),
        env
      );
    }
  } catch (e) {
    console.error('Quote-submission emails failed:', e.message);
  }

  return jsonResponse({ success: true, quote_count: count });
}

// ── Consumer instructs a conveyancer ─────────────────────────────────────────
async function handleInstruct(request, env) {
  const body = await request.json();
  const { lead_uuid, quote_id } = body;

  if (!lead_uuid || !quote_id) {
    return jsonResponse({ error: 'Missing lead_uuid or quote_id' }, 400);
  }

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(lead_uuid).first();
  if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

  if (lead.status === 'instructed') {
    return jsonResponse({ error: 'Already instructed' }, 409);
  }

  const quote = await env.DB.prepare(`
    SELECT cq.*, c.name AS firm_name, c.email AS conveyancer_email, c.phone AS conveyancer_phone
    FROM conveyancer_quotes cq
    JOIN conveyancers c ON cq.conveyancer_id = c.id
    WHERE cq.id = ? AND cq.lead_uuid = ?
  `).bind(parseInt(quote_id), lead_uuid).first();
  if (!quote) return jsonResponse({ error: 'Quote not found' }, 404);

  const now = new Date().toISOString();
  const propertyAddress = lead.property_address || lead.postcode;

  // Update lead and quote
  await Promise.all([
    env.DB.prepare(
      'UPDATE leads SET status = ?, instructed_conveyancer_id = ?, instructed_at = ?, updated_at = ? WHERE id = ?'
    ).bind('instructed', quote.conveyancer_id, now, now, lead_uuid).run(),
    env.DB.prepare('UPDATE conveyancer_quotes SET chosen = 1 WHERE id = ?').bind(parseInt(quote_id)).run(),
  ]);

  // Get agent if applicable
  let agent = null;
  if (lead.agent_ref && lead.agent_ref !== 'findconveyancers' && lead.agent_ref !== 'direct') {
    agent = await env.DB.prepare('SELECT * FROM agents WHERE ref = ?').bind(lead.agent_ref).first();
  }

  // Conveyancers who quoted but were not chosen (for a polite update email).
  const { results: otherQuotes } = await env.DB.prepare(`
    SELECT c.name, c.email, c.delivery_email
    FROM conveyancer_quotes cq JOIN conveyancers c ON cq.conveyancer_id = c.id
    WHERE cq.lead_uuid = ? AND cq.conveyancer_id != ?
  `).bind(lead_uuid, quote.conveyancer_id).all();

  // Fire all notification emails. Failures must never break the API response.
  try {
    await Promise.all([
      sendEmail(quote.conveyancer_email,
        `You've been instructed: ${lead.first_name} ${lead.last_name}`,
        emailConveyancerInstructed(lead, quote, propertyAddress), env),
      sendEmail(lead.email,
        `${quote.firm_name} will contact you`,
        emailConsumerConfirmed(lead, quote, propertyAddress), env),
      sendEmail(env.NOTIFY_EMAIL,
        `New instruction: ${lead.first_name} ${lead.last_name}`,
        emailAdminInstruction(lead, quote, propertyAddress, agent), env),
      agent ? sendEmail(agent.email,
        `Your referral instructed: ${lead.first_name} ${lead.last_name}`,
        emailAgentInstruction(lead, quote, propertyAddress, agent), env, EMAIL_FROM_PARTNER) : Promise.resolve(),
      ...(otherQuotes || []).map(c => sendEmail(
        c.delivery_email || c.email,
        'Update on your conveyancing quote',
        emailConveyancerNotSelected(c, lead, propertyAddress), env)),
    ]);
  } catch (e) {
    console.error('Instruction emails failed:', e.message);
  }

  return jsonResponse({
    success: true,
    conveyancer: {
      name:        quote.firm_name,
      email:       quote.conveyancer_email,
      phone:       quote.conveyancer_phone,
      total_quote: quote.total_quote,
    },
  });
}

// ── Admin: login ───────────────────────────────────────────────────────────────
async function handleAdminLogin(request, env) {
  const body = await request.json();
  if (body.password === env.ADMIN_PASSWORD) {
    return jsonResponse({ success: true, token: env.ADMIN_PASSWORD });
  }
  return jsonResponse({ error: 'Invalid password' }, 401);
}

// ── Admin: list leads (with quote counts) ─────────────────────────────────────
async function handleGetLeads(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url    = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const limit  = parseInt(url.searchParams.get('limit')  || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let where = [];
  const params = [];

  if (status) { where.push('l.status = ?'); params.push(status); }
  if (search) { where.push('(l.first_name || " " || l.last_name LIKE ? OR l.email LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { results } = await env.DB.prepare(`
    SELECT
      l.*,
      COUNT(cq.id) AS quote_count,
      cv.name       AS instructed_firm
    FROM leads l
    LEFT JOIN conveyancer_quotes cq ON cq.lead_uuid = l.id
    LEFT JOIN conveyancers cv ON cv.id = l.instructed_conveyancer_id
    ${whereClause}
    GROUP BY l.id
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  const leads = results.map(l => ({
    ...l,
    transaction_types: JSON.parse(l.transaction_types || '[]'),
  }));

  return jsonResponse({ leads, total: leads.length });
}

// ── Admin: update lead status ──────────────────────────────────────────────────
async function handleUpdateLead(request, env, id) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body    = await request.json();
  const allowed = ['new', 'quotes_sent', 'instructed', 'completed', 'contacted', 'converted', 'lost'];

  if (!allowed.includes(body.status)) return jsonResponse({ error: 'Invalid status' }, 400);

  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE leads SET status = ?, notes = ?, updated_at = ? WHERE id = ?')
    .bind(body.status, body.notes || '', now, id).run();

  return jsonResponse({ success: true });
}

// ── Funnel tracking ────────────────────────────────────────────────────────────
async function handleTrack(request, env) {
  const body = await request.json().catch(() => ({}));
  const event = (body.event || '').trim().slice(0, 64);
  if (!event) return jsonResponse({ error: 'Missing event' }, 400);
  await env.DB.prepare(
    'INSERT INTO page_events (event, created_at) VALUES (?, datetime("now"))'
  ).bind(event).run();
  return jsonResponse({ ok: true });
}

// ── Admin: stats ───────────────────────────────────────────────────────────────
async function handleGetStats(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const [total, byStatus, recent, quoteCount, instructedCount, buttonClicks, formSubmits] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM leads').first(),
    env.DB.prepare('SELECT status, COUNT(*) AS cnt FROM leads GROUP BY status').all(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM leads WHERE created_at > datetime("now","-7 days")').first(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM conveyancer_quotes').first(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM leads WHERE status = "instructed"').first(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM page_events WHERE event = "get_quotes_view"').first(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM page_events WHERE event = "form_submitted"').first(),
  ]);

  return jsonResponse({
    total:         total.cnt,
    thisWeek:      recent.cnt,
    totalQuotes:   quoteCount.cnt,
    instructed:    instructedCount.cnt,
    byStatus:      byStatus.results,
    buttonClicks:  buttonClicks.cnt,
    formSubmits:   formSubmits.cnt,
  });
}

// ── Public: conveyancer self-signup ────────────────────────────────────────────
async function handleConveyancerSignup(request, env) {
  const body = await request.json().catch(() => ({}));

  const name              = (body.name           || '').trim();
  const email             = (body.email          || '').trim().toLowerCase();
  const delivery_email    = (body.delivery_email || '').trim().toLowerCase();
  const phone             = (body.phone          || '').trim();
  const contact_name      = (body.contact_name   || '').trim();
  const role              = (body.role           || '').trim();
  const regulated_by      = (body.regulated_by   || '').trim();
  const reg_number        = (body.reg_number     || '').trim();
  const regions           = Array.isArray(body.regions)           ? body.regions           : [];
  const transaction_types = Array.isArray(body.transaction_types) ? body.transaction_types : [];
  const notes             = (body.notes          || '').trim();

  if (!name || !email || !phone || !contact_name || !regulated_by || !reg_number || regions.length === 0) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const id                 = crypto.randomUUID();
  const now                = new Date().toISOString();
  const agreement_version  = '1.0';
  const agreed_at          = now;

  // Ensure columns exist (idempotent, errors from duplicate columns are swallowed)
  for (const col of [
    'ALTER TABLE conveyancers ADD COLUMN delivery_email TEXT',
    'ALTER TABLE conveyancers ADD COLUMN contact_name TEXT',
    'ALTER TABLE conveyancers ADD COLUMN role TEXT',
    'ALTER TABLE conveyancers ADD COLUMN regulated_by TEXT',
    'ALTER TABLE conveyancers ADD COLUMN reg_number TEXT',
    'ALTER TABLE conveyancers ADD COLUMN transaction_types TEXT',
    'ALTER TABLE conveyancers ADD COLUMN notes TEXT',
    'ALTER TABLE conveyancers ADD COLUMN agreed_at TEXT',
    'ALTER TABLE conveyancers ADD COLUMN agreement_version TEXT',
  ]) {
    try { await env.DB.exec(col); } catch (_) {}
  }

  try {
    await env.DB.prepare(`
      INSERT INTO conveyancers
        (id, name, email, delivery_email, phone, contact_name, role,
         regulated_by, reg_number, regions, transaction_types, notes,
         agreed_at, agreement_version, active, fee_per_lead, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).bind(
      id, name, email, delivery_email, phone, contact_name, role,
      regulated_by, reg_number,
      JSON.stringify(regions), JSON.stringify(transaction_types), notes,
      agreed_at, agreement_version, now
    ).run();
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return jsonResponse({ error: 'Email already registered' }, 409);
    }
    throw err;
  }

  const agreedDate = new Date(agreed_at).toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/London', timeZoneName: 'short',
  });

  const detailsTable = `
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;width:100%;margin-bottom:16px">
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Firm name</td><td>${name}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Regulated by</td><td>${regulated_by}: ${reg_number}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Contact name</td><td>${contact_name}${role ? ` (${role})` : ''}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Email</td><td>${email}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Referral delivery email</td><td>${delivery_email || email}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Phone</td><td>${phone}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Counties covered</td><td>${regions.join(', ')}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Transaction types</td><td>${transaction_types.join(', ')}</td></tr>
      ${notes ? `<tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-weight:600;white-space:nowrap">Notes</td><td>${notes}</td></tr>` : ''}
    </table>`;

  const feesTable = `
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;width:100%;margin-bottom:16px">
      <tr style="background:#f9fafb"><th style="padding:6px 12px;text-align:left;font-weight:600">Transaction type</th><th style="padding:6px 12px;text-align:left;font-weight:600">Completion fee (ex-VAT)</th></tr>
      <tr><td style="padding:5px 12px;border-top:1px solid #e5e7eb">Purchase</td><td style="padding:5px 12px;border-top:1px solid #e5e7eb">£200</td></tr>
      <tr><td style="padding:5px 12px;border-top:1px solid #e5e7eb">Sale</td><td style="padding:5px 12px;border-top:1px solid #e5e7eb">£200</td></tr>
      <tr><td style="padding:5px 12px;border-top:1px solid #e5e7eb">New Build</td><td style="padding:5px 12px;border-top:1px solid #e5e7eb">£200</td></tr>
      <tr><td style="padding:5px 12px;border-top:1px solid #e5e7eb">Remortgage</td><td style="padding:5px 12px;border-top:1px solid #e5e7eb">£100</td></tr>
    </table>`;

  const agreementBody = `
    <p>FindConveyancers.co.uk, operated by Corre Connections, agrees to send you conveyancing referrals on the following terms.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">Your Details</h3>${detailsTable}
    <h3 style="margin:20px 0 8px;font-size:15px">Your Fees</h3>
    <p style="font-size:14px;margin-bottom:8px">You pay on completion only, at the following rates:</p>${feesTable}
    <p style="font-size:13px;color:#6b7280">Fees are exclusive of VAT.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">Referrals</h3>
    <p style="font-size:14px">Each referral we send you includes the client's name, contact details, property address, indicative value, transaction type, and referral source. We warrant that each referral contains accurate contact details and relates to a genuine enquiry.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">Your Obligations</h3>
    <ul style="font-size:14px;padding-left:20px;line-height:1.8">
      <li>You must hold a current SRA or CLC authorisation. Tell us immediately if that changes.</li>
      <li>Respond to each referral with a fee quote within 24 hours (excluding weekends and bank holidays). If you don't respond in time we may offer the referral to another firm. No refund applies.</li>
      <li>Deal with clients professionally and in line with your regulatory obligations.</li>
      <li>Keep your profile on the platform accurate.</li>
    </ul>
    <h3 style="margin:20px 0 8px;font-size:15px">Payment</h3>
    <p style="font-size:14px"><strong>You pay on completion only.</strong> No fee is due on delivery of a referral. No fee is due if the client doesn't instruct you. No fee is due if the transaction falls through before completion.</p>
    <p style="font-size:14px"><strong>You must report every completion</strong> that originated from one of our referrals within 5 working days of the completion date, providing the referral reference number, property address, completion date, and transaction value.</p>
    <p style="font-size:14px"><strong>We verify independently.</strong> We may verify transaction completion through the client, the estate agent involved, or HM Land Registry records. If we identify a completion you haven't reported, we'll invoice you for it.</p>
    <p style="font-size:14px"><strong>The fee applies however the instruction came about.</strong> If we sent you a referral for a client and that client's transaction completes whether or not they used our quote comparison, and regardless of how you describe the resulting instruction the completion fee is owed.</p>
    <p style="font-size:14px">Payment is due within 14 days of invoice. Late payments accrue interest at 8% above the Bank of England base rate under the Late Payment of Commercial Debts (Interest) Act 1998. We may suspend your account if an invoice is more than 21 days overdue.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">What We're Not Responsible For</h3>
    <p style="font-size:14px">We are not a party to your retainer with any client and have no responsibility for the legal services you provide. We are not liable if a referral doesn't convert to an instruction or if a transaction falls through before completion.</p>
    <p style="font-size:14px">Our total liability to you for anything arising from this agreement is capped at the total fees you have paid us in the 3 months before the relevant event.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">Data</h3>
    <p style="font-size:14px">You will receive personal data about prospective clients. Use it only to provide a quote and, if instructed, to carry out the conveyancing. You must comply with UK GDPR and be registered with the ICO. We are each independent data controllers.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">Ending the Agreement</h3>
    <p style="font-size:14px">Either party can end this agreement with 24 hours' prior written notice. We can end it immediately if you lose your SRA or CLC authorisation, or materially breach these terms and don't remedy it within 14 days of being notified.</p>
    <p style="font-size:14px">Completion fees for referrals already delivered remain payable after termination.</p>
    <h3 style="margin:20px 0 8px;font-size:15px">General</h3>
    <p style="font-size:14px">This agreement is governed by English law and subject to the exclusive jurisdiction of the courts of England and Wales.</p>
    <p style="font-size:14px">We may update these terms with 30 days' notice via the platform. Continued use after the notice period constitutes acceptance.</p>
    <p style="font-size:14px">These terms, together with the fees and preferences set out above, form the entire agreement between us regarding the supply of referrals.</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
    <p style="font-size:13px;color:#374151"><strong>Agreement accepted by:</strong> ${contact_name}${role ? ` (${role})` : ''} on behalf of ${name}</p>
    <p style="font-size:13px;color:#374151"><strong>Accepted at:</strong> ${agreedDate}</p>
    <p style="font-size:13px;color:#374151"><strong>Agreement version:</strong> ${agreement_version}</p>
    <p style="font-size:13px;color:#374151"><strong>Reference:</strong> ${id}</p>`;

  // Welcome the conveyancer with the new styling, and keep their accepted
  // Referral Supply Agreement embedded as their legal record. Email failures
  // must never break the API response.
  const agreementRecord =
    `<h2 style="font-size:16px;margin:0 0 6px;color:#0F172A;">Your Referral Supply Agreement</h2>
     <p style="font-size:12px;color:#6B7280;margin:0 0 14px;">This confirms your acceptance of our Referral Supply Agreement. Please keep it for your records. We&rsquo;ll review your application and confirm your account within 1 working day.</p>
     ${agreementBody}`;
  try {
    await sendEmail(
      email,
      `You're now a FindConveyancers partner`,
      emailConveyancerWelcome({ name, contact_name, email, delivery_email }, agreementRecord),
      env
    );

    // Notify admin
    await sendEmail(
      env.NOTIFY_EMAIL,
      `New conveyancer signup: ${name}`,
      emailAdminNewConveyancer(name, detailsTable, agreedDate, agreement_version, id),
      env
    );
  } catch (e) {
    console.error('Conveyancer-signup emails failed:', e.message);
  }

  return jsonResponse({ success: true, id }, 201);
}

/// ── Public: estate agent signup ───────────────────────────────────────────────
async function handleEstateAgentSignup(request, env) {
  const body = await request.json().catch(() => ({}));

  const name     = (body.name     || '').trim();
  const business = (body.business || '').trim();
  const email    = (body.email    || '').trim().toLowerCase();
  const phone    = (body.phone    || '').trim();

  if (!name || !business || !email || !phone) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  try {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS estate_agent_leads (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        business   TEXT NOT NULL,
        email      TEXT NOT NULL,
        phone      TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  } catch (e) {
    console.error('estate_agent_leads table create error:', e.message);
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await env.DB.prepare(`
      INSERT INTO estate_agent_leads (id, name, business, email, phone, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, name, business, email, phone, now).run();
  } catch (e) {
    console.error('estate_agent_leads insert error:', e.message);
    return jsonResponse({ error: 'Database error: ' + e.message }, 500);
  }

  // Bridge to the `agents` table so the referral link works from day one.
  // Created PENDING (active = 0, fee = 0); an admin activates it and sets the
  // fee later. Same id as the enquiry row, so ?ref=<id> attributes via
  // handleLeadSubmission's "WHERE id = ? OR ref = ?" lookup.
  const agentRef = (business.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'agent') + '-' + id.slice(0, 6);
  try {
    await env.DB.prepare(`
      INSERT INTO agents (id, ref, name, email, phone, password, active, fee_per_lead, created_at)
      VALUES (?, ?, ?, ?, ?, '', 0, 0, ?)
    `).bind(id, agentRef, business, email, phone, now).run();
  } catch (e) {
    console.error('agents bridge insert error:', e.message);
  }

  await sendEmail(
    env.NOTIFY_EMAIL,
    `New estate agent partnership enquiry: ${business}`,
    `<p>An estate agent has expressed interest in partnering with FindConveyancers.</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Name</td><td>${name}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Agency</td><td>${business}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Email</td><td>${email}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Phone</td><td>${phone}</td></tr>
    </table>
    <p style="margin-top:16px">Follow up within 24 hours to discuss the referral partnership scheme.</p>`,
    env
  );

  // Welcome the agent with their referral link. Email failures must never
  // break the API response.
  try {
    await sendEmail(
      email,
      'Welcome: your referral link is live',
      emailEstateAgentWelcome({ id, name, business, email, phone }),
      env,
      EMAIL_FROM_PARTNER
    );
  } catch (e) {
    console.error('Estate-agent welcome email failed:', e.message);
  }

  return jsonResponse({ success: true, id }, 201);
}

// ── Admin: list conveyancers ───────────────────────────────────────────────────
async function handleGetConveyancers(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    'SELECT * FROM conveyancers ORDER BY name ASC'
  ).all();

  return jsonResponse({ conveyancers: results });
}

// ── Admin: activate / deactivate / update conveyancer ─────────────────────────
async function handlePatchConveyancer(path, request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const id = path.split('/').pop();
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);

  const body = await request.json().catch(() => ({}));
  const fields = [];
  const values = [];

  if (body.active !== undefined) { fields.push('active = ?'); values.push(body.active ? 1 : 0); }
  if (body.fee_per_lead !== undefined) { fields.push('fee_per_lead = ?'); values.push(Number(body.fee_per_lead)); }

  if (!fields.length) return jsonResponse({ error: 'Nothing to update' }, 400);

  const now = new Date().toISOString();
  fields.push('updated_at = ?'); values.push(now);
  values.push(id);

  try {
    await env.DB.exec('ALTER TABLE conveyancers ADD COLUMN updated_at TEXT');
  } catch (_) {}

  await env.DB.prepare(
    `UPDATE conveyancers SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const row = await env.DB.prepare('SELECT * FROM conveyancers WHERE id = ?').bind(id).first();
  if (!row) return jsonResponse({ error: 'Not found' }, 404);

  // Send activation email to conveyancer
  if (body.active === true) {
    await sendEmail(
      row.email,
      'Your FindConveyancers account is now active',
      `<p>Dear ${row.contact_name || row.name},</p>
      <p>Your FindConveyancers account for <strong>${row.name}</strong> has been activated. You will now start receiving referrals matching your registered counties and transaction types to <strong>${row.delivery_email || row.email}</strong>.</p>
      <p>Each referral email will include a unique link to submit your quote. Remember to respond within 24 hours.</p>
      <p>If you have any questions, reply to this email or contact us at <a href="mailto:hello@findconveyancers.co.uk">hello@findconveyancers.co.uk</a>.</p>
      <p>Thank you for joining FindConveyancers.</p>`,
      env
    );
  }

  return jsonResponse({ success: true, conveyancer: row });
}

// ── Admin: add conveyancer ─────────────────────────────────────────────────────
async function handleAddConveyancer(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  if (!body.name || !body.email) {
    return jsonResponse({ error: 'Missing required fields: name, email' }, 400);
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await env.DB.prepare(`
      INSERT INTO conveyancers (id, name, email, phone, regions, active, fee_per_lead, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      id,
      body.name.trim(),
      body.email.trim().toLowerCase(),
      body.phone || '',
      JSON.stringify(body.regions || []),
      body.fee_per_lead || 0,
      now
    ).run();

    return jsonResponse({ success: true, id });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return jsonResponse({ error: 'Email already registered' }, 409);
    }
    throw err;
  }
}

/// ── Admin: list agents ────────────────────────────────────────────────────────
async function handleGetAgents(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
  const { results } = await env.DB.prepare(
    'SELECT id, ref, name, email, phone, fee_per_lead, active, created_at FROM agents ORDER BY name ASC'
  ).all();
  // Attach lead counts
  const { results: counts } = await env.DB.prepare(
    'SELECT agent_ref, COUNT(*) AS cnt FROM leads GROUP BY agent_ref'
  ).all();
  const countMap = Object.fromEntries(counts.map(c => [c.agent_ref, c.cnt]));
  return jsonResponse({ agents: results.map(a => ({ ...a, lead_count: countMap[a.ref] || 0 })) });
}

// ── Admin: add agent ──────────────────────────────────────────────────────────
async function handleAddAgent(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  if (!body.ref || !body.name || !body.email) {
    return jsonResponse({ error: 'Missing required fields: ref, name, email' }, 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO agents (id, ref, name, email, phone, fee_per_lead, active, created_at, password)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    body.id || crypto.randomUUID(),
    body.ref.toLowerCase().trim(),
    body.name.trim(),
    body.email.trim().toLowerCase(),
    body.phone || '',
    body.fee_per_lead || 0,
    now,
    body.password || 'temp123'
  ).run();

  return jsonResponse({ success: true });
}

// ── Admin: send a partner their monthly referral summary ──────────────────────
// TODO: trigger this from a monthly Cloudflare Cron (scheduled handler) for all
// active agents, instead of (or in addition to) this admin-triggered endpoint.
async function handleSendPartnerSummary(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { agent_id } = await request.json().catch(() => ({}));
  if (!agent_id) return jsonResponse({ error: 'agent_id required' }, 400);

  const agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ? OR ref = ?')
    .bind(agent_id, agent_id).first();
  if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);

  // This month + previous month windows (UTC).
  const d = new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const startThis = new Date(Date.UTC(y, m, 1)).toISOString();
  const startPrev = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const monthName = (dt) => dt.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

  const one = async (sql, binds) => (await env.DB.prepare(sql).bind(...binds).first())?.c || 0;
  const referrals       = await one(`SELECT COUNT(*) AS c FROM leads WHERE agent_ref = ? AND created_at >= ?`, [agent.ref, startThis]);
  const referralsPrev   = await one(`SELECT COUNT(*) AS c FROM leads WHERE agent_ref = ? AND created_at >= ? AND created_at < ?`, [agent.ref, startPrev, startThis]);
  const quotes          = await one(`SELECT COUNT(DISTINCT l.id) AS c FROM leads l JOIN conveyancer_quotes cq ON cq.lead_uuid = l.id WHERE l.agent_ref = ? AND l.created_at >= ?`, [agent.ref, startThis]);
  const quotesPrev      = await one(`SELECT COUNT(DISTINCT l.id) AS c FROM leads l JOIN conveyancer_quotes cq ON cq.lead_uuid = l.id WHERE l.agent_ref = ? AND l.created_at >= ? AND l.created_at < ?`, [agent.ref, startPrev, startThis]);
  const completions     = await one(`SELECT COUNT(*) AS c FROM leads WHERE agent_ref = ? AND status = 'instructed' AND instructed_at >= ?`, [agent.ref, startThis]);
  const completionsPrev = await one(`SELECT COUNT(*) AS c FROM leads WHERE agent_ref = ? AND status = 'instructed' AND instructed_at >= ? AND instructed_at < ?`, [agent.ref, startPrev, startThis]);

  const feePence  = agent.fee_per_lead || 0;
  const earnP     = completions * feePence;
  const earnPrevP = completionsPrev * feePence;
  const money     = (p) => '£' + Math.round(p / 100).toLocaleString('en-GB');

  const prevName = monthName(new Date(Date.UTC(y, m - 1, 1)));
  const delta = (cur, prev) => cur - prev > 0
    ? { delta: `↑ +${cur - prev} vs ${prevName}`, up: true }
    : { delta: `Same as ${prevName}`, up: false };
  const dr = delta(referrals, referralsPrev);
  const dq = delta(quotes, quotesPrev);
  const dc = delta(completions, completionsPrev);
  const de = earnP - earnPrevP > 0
    ? { delta: `↑ +${money(earnP - earnPrevP)} vs ${prevName}`, up: true }
    : { delta: `Same as ${prevName}`, up: false };

  const stats = {
    month: monthName(new Date(Date.UTC(y, m, 1))), year: y,
    referrals, quotes, completions, earnings: money(earnP),
    deltaReferrals: dr.delta,   deltaReferralsUp: dr.up,
    deltaQuotes: dq.delta,      deltaQuotesUp: dq.up,
    deltaCompletions: dc.delta, deltaCompletionsUp: dc.up,
    deltaEarnings: de.delta,    deltaEarningsUp: de.up,
  };

  try {
    await sendEmail(
      agent.email,
      `Your ${stats.month} ${stats.year} referral summary`,
      emailEstateAgentMonthlySummary(agent, stats),
      env,
      EMAIL_FROM_PARTNER
    );
  } catch (e) {
    console.error('Partner-summary email failed:', e.message);
  }

  return jsonResponse({ success: true, stats });
}

// ── Admin: send one of every email type to an address, for visual review ──────
// Utility for previewing the full email suite in a real inbox. Admin-only.
async function handlePreviewEmails(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { to } = await request.json().catch(() => ({}));
  if (!to) return jsonResponse({ error: 'to required' }, 400);

  // Realistic sample data (no real customers).
  const body  = { firstName: 'Jordan', lastName: 'Avery', email: to, phone: '07700 900123', propertyAddress: '14 Castle Street, Bedford, MK40 3RT', propertyValue: 285000, propertyType: 'Leasehold flat', transactionTypes: ['Buying'], freehold: 'Leasehold', newBuild: 'no', city: 'Bedford' };
  const conv  = { name: 'Mason & Partners Solicitors', contact_name: 'Sam Mason', email: to, delivery_email: to };
  const lead  = { id: 'sample-lead-0001', first_name: 'Jordan', last_name: 'Avery', email: to, phone: '07700 900123', property_address: '14 Castle Street, Bedford, MK40 3RT', postcode: 'Bedford' };
  const quote = { firm_name: 'Mason & Partners Solicitors', conveyancer_email: 'hello@masonpartners.co.uk', conveyancer_phone: '01234 567890', total_quote: 107400, conveyancer_id: 'sample-conv-1' };
  const agent = { id: 'sample-agent-1', ref: 'bedford-estates-abc123', name: 'Bedford Estates', email: to, fee_per_lead: 20000 };
  const quotes = [
    { firm_name: 'Hartley Conveyancing Ltd', total_quote: 85000 },
    { firm_name: 'Mason & Partners Solicitors', total_quote: 107400 },
    { firm_name: 'Blackwood Legal LLP', total_quote: 124800 },
  ];
  const d = new Date();
  const stats = {
    month: d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }), year: d.getUTCFullYear(),
    referrals: 14, quotes: 11, completions: 4, earnings: '£600',
    deltaReferrals: '↑ +3 vs last month', deltaReferralsUp: true,
    deltaQuotes: '↑ +2 vs last month', deltaQuotesUp: true,
    deltaCompletions: 'Same as last month', deltaCompletionsUp: false,
    deltaEarnings: '↑ +£150 vs last month', deltaEarningsUp: true,
  };
  const C = EMAIL_FROM_CONSUMER, P = EMAIL_FROM_PARTNER;

  // [label, subject, html, fromAddress]
  const previews = [
    ['Consumer · Quote received',        'Your conveyancing quote request is confirmed ✓', emailClientConfirmation(body, lead.id), C],
    ['Consumer · First quote arrived',   'Your first conveyancing quote has arrived',       emailConsumerFirstQuoteArrived(lead), C],
    ['Consumer · Quotes ready',          'Your conveyancing quotes are ready to compare',   emailConsumerQuotesReady(lead, lead.property_address, lead.id, quotes), C],
    ['Consumer · Conveyancer confirmed', `${quote.firm_name} will contact you`,             emailConsumerConfirmed(lead, quote, lead.property_address), C],
    ['Conveyancer · New referral',       'New referral: Leasehold flat at £285,000',       emailConveyancerNewLead(body, lead.id, conv, 'https://findconveyancers.co.uk/quote.html?lead=sample'), C],
    ['Conveyancer · Instructed',         `You've been instructed: ${lead.first_name} ${lead.last_name}`, emailConveyancerInstructed(lead, quote, lead.property_address), C],
    ['Conveyancer · Not selected',       'Update on your conveyancing quote',               emailConveyancerNotSelected(conv, lead, lead.property_address), C],
    ['Conveyancer · Partner welcome',    `You're now a FindConveyancers partner`,           emailConveyancerWelcome(conv, '<p style="font-size:12px;color:#6B7280;">[Your Referral Supply Agreement record appears here.]</p>'), C],
    ['Agent · Partner welcome',          'Welcome: your referral link is live',            emailEstateAgentWelcome(agent), P],
    ['Agent · Referral submitted',       `Your referral has entered FindConveyancers: ${lead.first_name} ${lead.last_name}`, emailEstateAgentReferralSubmitted(agent, lead), P],
    ['Agent · Referral instructed',      `Your referral instructed: ${lead.first_name} ${lead.last_name}`, emailAgentInstruction(lead, quote, lead.property_address, agent), P],
    ['Agent · Monthly summary',          `Your ${stats.month} ${stats.year} referral summary`, emailEstateAgentMonthlySummary(agent, stats), P],
    ['Admin · New lead',                 'New lead: Jordan Avery',                          emailAdminNewLead(body, lead.id), C],
    ['Admin · New conveyancer',          'New conveyancer signup: Mason & Partners Solicitors', emailAdminNewConveyancer('Mason & Partners Solicitors', '<table style="border-collapse:collapse;font-size:12.5px;width:100%"><tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-weight:600">Firm</td><td>Mason &amp; Partners Solicitors</td></tr></table>', new Date().toLocaleString('en-GB'), '1.0', 'sample-conv-1'), C],
    ['Admin · New instruction',          'New instruction: Jordan Avery',                  emailAdminInstruction(lead, quote, lead.property_address, agent), C],
  ];

  const results = [];
  for (const [label, subject, html, from] of previews) {
    const ok = await sendEmail(to, `[PREVIEW] ${label}: ${subject}`, html, env, from);
    results.push({ label, ok });
  }
  const sent = results.filter(r => r.ok).length;
  return jsonResponse({ success: true, to, sent, total: previews.length, results });
}

// ── Agent: login ───────────────────────────────────────────────────────────────
async function handleAgentLogin(request, env) {
  const body = await request.json();
  if (!body.ref || !body.password) return jsonResponse({ error: 'Missing ref or password' }, 400);

  const agent = await env.DB.prepare('SELECT * FROM agents WHERE ref = ? AND active = 1').bind(body.ref).first();
  if (!agent || body.password !== agent.password) {
    return jsonResponse({ error: 'Invalid credentials' }, 401);
  }

  const token = btoa(`${agent.ref}:${agent.password}`);
  return jsonResponse({ success: true, token, agentRef: agent.ref });
}

// ── Agent: me ─────────────────────────────────────────────────────────────────
async function handleAgentMe(request, env) {
  const agent = await getAgentFromToken(request, env);
  if (!agent) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(`
    SELECT id, transaction_types, property_type, property_value,
           postcode, timeline, first_name, last_name, status, created_at
    FROM leads WHERE agent_ref = ? ORDER BY created_at DESC
  `).bind(agent.ref).all();

  const leads    = results.map(l => ({ ...l, transaction_types: JSON.parse(l.transaction_types || '[]') }));
  const converted = leads.filter(l => l.status === 'converted' || l.status === 'instructed').length;

  return jsonResponse({
    agent:    { ref: agent.ref, name: agent.name, email: agent.email, feePerLead: agent.fee_per_lead },
    leads,
    earnings: { feePerLead: agent.fee_per_lead, totalEarned: converted * (agent.fee_per_lead || 0), converted, paid: 0 },
    byStatus: ['new','quoted','instructed','completed','lost'].map(s => ({ status: s, count: leads.filter(l => l.status === s).length })),
  });
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
function isAdminAuthorized(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

async function getAgentFromToken(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  try {
    const [ref, password] = atob(token).split(':');
    const agent = await env.DB.prepare('SELECT * FROM agents WHERE ref = ? AND active = 1').bind(ref).first();
    return (agent && agent.password === password) ? agent : null;
  } catch { return null; }
}

// ── Email: Resend ──────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html, env, from) {
  if (!to || !env.RESEND_API_KEY) {
    console.warn('sendEmail skipped: no recipient or no RESEND_API_KEY');
    return false;
  }
  // We send from noreply@/partners@, but replies should reach a monitored
  // mailbox: partner emails → partners@, everything else → hello@.
  const fromAddr = from || 'FindConveyancers <noreply@findconveyancers.co.uk>';
  const replyTo  = fromAddr.includes('partners@') ? 'partners@findconveyancers.co.uk' : 'hello@findconveyancers.co.uk';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     fromAddr,
        reply_to: replyTo,
        to:       Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error('Resend error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Email failed:', e.message);
    return false;
  }
}

// ── Admin: assign lead to a specific conveyancer ──────────────────────────────
async function handleAssignLead(request, env, leadId) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { conveyancer_id } = await request.json().catch(() => ({}));
  if (!conveyancer_id) return jsonResponse({ error: 'conveyancer_id required' }, 400);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

  const conv = await env.DB.prepare('SELECT * FROM conveyancers WHERE id = ?').bind(conveyancer_id).first();
  if (!conv) return jsonResponse({ error: 'Conveyancer not found' }, 404);

  const quoteLink = `https://findconveyancers.co.uk/quote.html?lead=${leadId}&conv=${conv.id}`;
  const txTypes   = JSON.parse(lead.transaction_types || '[]');
  const body      = {
    firstName:     lead.first_name,
    lastName:      lead.last_name,
    propertyAddress: lead.postcode || lead.property_address || '',
    propertyValue: lead.property_value,
    propertyType:  lead.property_type,
    transactionTypes: txTypes,
    timeline:      lead.timeline || '',
  };

  await sendEmail(
    conv.delivery_email || conv.email,
    `New referral: ${lead.property_type || 'Property'} at £${(parseInt(lead.property_value)||0).toLocaleString('en-GB')}`,
    emailConveyancerNewLead(body, leadId, conv, quoteLink),
    env
  );

  // Log assignment
  const now = new Date().toISOString();
  try {
    await env.DB.exec('ALTER TABLE leads ADD COLUMN assigned_conveyancers TEXT');
  } catch (_) {}
  const existing = JSON.parse(lead.assigned_conveyancers || '[]');
  if (!existing.includes(conveyancer_id)) existing.push(conveyancer_id);
  await env.DB.prepare('UPDATE leads SET assigned_conveyancers = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(existing), now, leadId).run();

  return jsonResponse({ success: true, sent_to: conv.name });
}

// ── Email all active conveyancers when a new lead arrives ──────────────────────
async function emailConveyancers(body, leadUuid, env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM conveyancers WHERE active = 1'
  ).all();

  await Promise.all(results.map(conv => {
    const quoteLink = `https://findconveyancers.co.uk/quote.html?lead=${leadUuid}&conv=${conv.id}`;
    return sendEmail(conv.email,
      `New quote request: ${body.propertyType || 'Property'} at £${(parseInt(body.propertyValue)||0).toLocaleString('en-GB')}`,
      emailConveyancerNewLead(body, leadUuid, conv, quoteLink),
      env
    );
  }));
}

// ── Email templates (email-safe: table-based layout, fully inlined styles) ─────
// Recreated from the design references in ./email templates/. No external fonts,
// no <style> blocks, no flexbox/grid, for broad email-client compatibility.

const EMAIL_FONT = "-apple-system,'Helvetica Neue',Arial,sans-serif";
const EMAIL_FROM_CONSUMER = 'FindConveyancers <noreply@findconveyancers.co.uk>';
const EMAIL_FROM_PARTNER  = 'FindConveyancers Partners <partners@findconveyancers.co.uk>';
// Brand favicon (blue rounded square, white house, green tick) inlined as base64.
const EMAIL_LOGO = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICAKICA8Y2lyY2xlIGN4PSIxNiIgY3k9IjE2IiByPSIxNiIgZmlsbD0iIzI1NjNlYiI+PC9jaXJjbGU+CiAgCiAgCiAgPGcgZmlsbD0iI2ZmZmZmZiI+CiAgICAKICAgIDxwYXRoIGQ9Ik0xNiA2IEwyNCAxMyBMMjMgMTMgTDIzIDI1IEwyMCAyNSBMMjAgMTggTDEyIDE4IEwxMiAyNSBMOSAyNSBMOSAxMyBMOCAxMyBaIj48L3BhdGg+CiAgICAKICAgIAogICAgPHJlY3QgeD0iMTQiIHk9IjIwIiB3aWR0aD0iNCIgaGVpZ2h0PSI1IiBmaWxsPSIjMjU2M2ViIj48L3JlY3Q+CiAgICAKICAgIAogICAgPHJlY3QgeD0iMTQiIHk9IjE0IiB3aWR0aD0iNCIgaGVpZ2h0PSIzIiByeD0iMC41IiBmaWxsPSIjMjU2M2ViIj48L3JlY3Q+CiAgPC9nPgogIAogIAogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMjQiIHI9IjUiIGZpbGw9IiMxMGI5ODEiPjwvY2lyY2xlPgogIDxwYXRoIGQ9Ik0yMS41IDI0IEwyMyAyNS41IEwyNi41IDIyIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGZpbGw9Im5vbmUiPjwvcGF0aD4KPC9zdmc+';

function emailLogo(size) {
  return `<img src="${EMAIL_LOGO}" width="${size}" height="${size}" alt="FindConveyancers" style="display:block;border:0;border-radius:7px;width:${size}px;height:${size}px;">`;
}

// Shared shell. opts: { partner, badge:{text,bg,color}, headline, sub, content,
// cta:{label,href,hideVisit}, postCta, dark:{label,items[]}, refer:{url} }
function emailWrap(opts) {
  const o = opts || {};
  const footerEmail = o.partner ? 'partners@findconveyancers.co.uk' : 'hello@findconveyancers.co.uk';

  const badge = o.badge
    ? `<div style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;background:${o.badge.bg};color:${o.badge.color};margin-bottom:13px;">${o.badge.text}</div>`
    : '';
  const hero = (o.headline || o.sub || badge) ? `
    <tr><td style="padding:24px 28px 20px;background:#EFF6FF;">
      ${badge}
      ${o.headline ? `<div style="font-size:27px;font-weight:800;line-height:1.15;color:#0F172A;letter-spacing:-1.2px;margin-bottom:10px;">${o.headline}</div>` : ''}
      ${o.sub ? `<div style="font-size:12.5px;color:#6B7280;line-height:1.65;">${o.sub}</div>` : ''}
    </td></tr>` : '';
  const content = o.content ? `<tr><td style="padding:22px 28px 8px;background:#fff;">${o.content}</td></tr>` : '';
  const cta = o.cta ? `
    <tr><td style="padding:4px 28px 24px;background:#fff;text-align:center;">
      <a href="${o.cta.href}" style="display:inline-block;background:#3B82F6;color:#fff;padding:13px 36px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:-0.2px;text-decoration:none;">${o.cta.label}</a>
      ${o.cta.hideVisit ? '' : `<div style="margin-top:10px;font-size:10px;color:#9CA3AF;">Or visit <a href="https://findconveyancers.co.uk" style="color:#3B82F6;text-decoration:none;font-weight:500;">findconveyancers.co.uk</a></div>`}
    </td></tr>` : '';
  const postCta = o.postCta ? `<tr><td style="padding:0 28px 22px;background:#fff;">${o.postCta}</td></tr>` : '';
  const refer = o.refer ? `
    <tr><td style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #E5E7EB;">
      <div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#3B82F6;margin-bottom:8px;">Refer a friend, earn &pound;75</div>
      <div style="font-size:11.5px;color:#374151;line-height:1.6;margin-bottom:10px;">Recommend FindConveyancers to a friend. If their matter completes, we&rsquo;ll send you &pound;75 as a thank you. Share your link:</div>
      ${eReferralBox(o.refer.url)}
    </td></tr>` : '';
  const dark = o.dark ? `
    <tr><td style="padding:18px 28px;background:#0F172A;">
      <div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#60A5FA;margin-bottom:12px;">${o.dark.label}</div>
      ${o.dark.items.map(t => `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;"><tr>
          <td valign="top" style="padding-right:10px;"><div style="width:14px;height:14px;border-radius:50%;background:#60A5FA;text-align:center;line-height:14px;color:#fff;font-size:9px;">&#10003;</div></td>
          <td style="font-size:11.5px;color:#CBD5E1;line-height:1.5;">${t}</td>
        </tr></table>`).join('')}
    </td></tr>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#E5E7EB;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E5E7EB;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:${EMAIL_FONT};">
    <tr><td style="height:4px;line-height:4px;font-size:0;background:#3B82F6;">&nbsp;</td></tr>
    <tr><td style="background:#ffffff;border-bottom:1px solid #E5E7EB;padding:11px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" style="vertical-align:middle;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;padding-right:8px;">${emailLogo(28)}</td>
            <td style="vertical-align:middle;font-size:14px;font-weight:700;color:#0F172A;letter-spacing:-0.3px;">FindConveyancers</td>
          </tr></table>
        </td>
        <td align="right" style="vertical-align:middle;font-size:10px;font-weight:500;color:#6B7280;">findconveyancers.co.uk</td>
      </tr></table>
    </td></tr>
    ${hero}
    ${content}
    ${cta}
    ${postCta}
    <tr><td style="height:3px;line-height:3px;font-size:0;background:#3B82F6;">&nbsp;</td></tr>
    ${dark}
    ${refer}
    <tr><td style="background:#3B82F6;padding:16px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" style="vertical-align:middle;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;padding-right:8px;">${emailLogo(22)}</td>
            <td style="vertical-align:middle;font-size:13px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">FindConveyancers</td>
          </tr></table>
        </td>
        <td align="right" style="vertical-align:middle;font-size:10px;color:rgba(255,255,255,0.72);">findconveyancers.co.uk</td>
      </tr></table>
      <div style="font-size:10px;color:rgba(255,255,255,0.72);padding-top:8px;">${footerEmail}</div>
    </td></tr>
    <tr><td style="padding:14px 22px;background:#F9FAFB;border-top:1px solid #E5E7EB;text-align:center;font-size:9.5px;color:#9CA3AF;line-height:1.8;">
      You received this email because you used findconveyancers.co.uk.<br>
      <a href="https://findconveyancers.co.uk/legal.html" style="color:#6B7280;text-decoration:none;">Privacy Policy</a> &middot; <a href="https://findconveyancers.co.uk/legal.html" style="color:#6B7280;text-decoration:none;">Terms of Service</a><br>
      FindConveyancers, operated by Corre Connections &middot; England &amp; Wales
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// ── Email content builders (email-safe fragments used inside emailWrap) ────────
function eSectionLabel(t) {
  return `<div style="font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#3B82F6;margin-bottom:14px;">${t}</div>`;
}
function eSteps(items) {
  return items.map((s, i) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;"><tr>
      <td valign="top" width="40" style="padding-right:14px;"><div style="width:26px;height:26px;border-radius:50%;background:#3B82F6;color:#ffffff;font-size:12px;font-weight:800;text-align:center;line-height:26px;">${i + 1}</div></td>
      <td valign="top">
        <div style="font-size:13px;font-weight:700;color:#0F172A;margin-bottom:3px;">${s.title}</div>
        <div style="font-size:11.5px;color:#6B7280;line-height:1.55;">${s.desc}</div>
      </td>
    </tr></table>`).join('');
}
function eInfoBox(text) {
  return `<div style="background:#EFF6FF;border:1px solid #DBEAFE;border-radius:8px;padding:10px 14px;margin-bottom:22px;font-size:11px;color:#1D4ED8;font-weight:600;line-height:1.5;">${text}</div>`;
}
function eDataTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;font-size:12.5px;">
    ${rows.map(([k, v]) => `<tr><td style="padding:8px 10px;border-bottom:1px solid #E5E7EB;font-weight:600;color:#0F172A;white-space:nowrap;width:42%;vertical-align:top;">${k}</td><td style="padding:8px 10px;border-bottom:1px solid #E5E7EB;color:#374151;vertical-align:top;">${v}</td></tr>`).join('')}
  </table>`;
}
function eQuoteCards(items) {
  return `<div style="margin-bottom:14px;">${items.map(q => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E5E7EB;border-radius:10px;margin-bottom:10px;"><tr>
      <td style="padding:12px 16px;vertical-align:middle;">
        <div style="font-size:12.5px;font-weight:700;color:#0F172A;margin-bottom:3px;">${q.firm}</div>
        <div style="font-size:10px;color:#6B7280;">${q.meta}</div>
      </td>
      <td align="right" style="padding:12px 16px;vertical-align:middle;white-space:nowrap;">
        <div style="font-size:19px;font-weight:800;color:#3B82F6;letter-spacing:-0.5px;line-height:1;">${q.price}</div>
        <div style="font-size:9px;color:#9CA3AF;margin-top:2px;">+ VAT + disbursements</div>
      </td>
    </tr></table>`).join('')}</div>`;
}
function eChecks(items, color) {
  const dot = color === 'blue' ? '#60A5FA' : '#10b981';
  return items.map(c => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:11px;"><tr>
      <td valign="top" width="24" style="padding-right:10px;"><div style="width:14px;height:14px;border-radius:50%;background:${dot};text-align:center;line-height:14px;color:#ffffff;font-size:9px;">&#10003;</div></td>
      <td valign="top">
        <div style="font-size:12.5px;font-weight:700;color:#0F172A;margin-bottom:2px;">${c.title}</div>
        <div style="font-size:11px;color:#6B7280;line-height:1.5;">${c.desc}</div>
      </td>
    </tr></table>`).join('');
}
function eStatsGrid(items) {
  const cell = (s) => s
    ? `<td width="50%" style="vertical-align:top;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px;margin:5px;">
        <div style="font-size:10px;color:#6B7280;margin-bottom:5px;">${s.label}</div>
        <div style="font-size:26px;font-weight:800;color:#0F172A;letter-spacing:-1px;line-height:1;margin-bottom:5px;">${s.value}</div>
        <div style="font-size:9.5px;font-weight:600;color:${s.up ? '#10b981' : '#94A3B8'};">${s.delta}</div>
      </div></td>`
    : '<td width="50%"></td>';
  let rows = '';
  for (let i = 0; i < items.length; i += 2) rows += `<tr>${cell(items[i])}${cell(items[i + 1])}</tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 -5px 16px;">${rows}</table>`;
}
function eReferralBox(url) {
  const shown = url.replace(/^https?:\/\//, '');
  return `<a href="${url}" style="display:block;background:#F8FAFC;border:1.5px solid #E2E8F0;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;font-weight:600;color:#0F172A;font-family:'Courier New',monospace;word-break:break-all;text-decoration:none;">${shown}</a>`;
}

function fmt(pence) { return '£' + (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPrice(p) { return '£' + parseInt(p || 0).toLocaleString('en-GB'); }

function emailClientConfirmation(body, leadUuid) {
  const trackLink = `https://findconveyancers.co.uk/compare.html?lead=${leadUuid}`;
  const content =
    eSectionLabel('What Happens Next') +
    eSteps([
      { title: 'We share your details', desc: 'Your property information is sent to regulated solicitors who specialise in your area and transaction type.' },
      { title: 'Quotes arrive in your inbox', desc: 'You&rsquo;ll receive competitive quotes directly to this email address, typically within a few hours of submitting.' },
      { title: 'Compare, choose, get moving', desc: 'Review quotes side by side. No obligation, no hidden fees. Choose the firm that works best for you.' },
    ]) +
    eInfoBox('All firms are SRA or CLC regulated &nbsp;&middot;&nbsp; Free to use &nbsp;&middot;&nbsp; No obligation') +
    `<div style="font-size:10px;color:#9CA3AF;line-height:1.6;">You can follow your request using the link below. This is your private tracking link, so please don&rsquo;t share it.</div>`;
  return emailWrap({
    badge: { text: 'Quote Request Received', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'We&rsquo;re finding your best<br>conveyancing quotes',
    sub: 'Regulated solicitors are reviewing your property details right now. You&rsquo;ll receive quotes directly to this inbox, typically within a few hours.',
    content,
    cta: { label: 'Track Your Request', href: trackLink, hideVisit: true },
    refer: { url: `https://findconveyancers.co.uk/?ref=${leadUuid}` },
  });
}

function emailConveyancerNewLead(body, leadUuid, conv, quoteLink) {
  const tx = Array.isArray(body.transactionTypes) ? body.transactionTypes.join(', ') : (body.transactionType || 'Not specified');
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">Hi ${conv.name}, you have a new referral from FindConveyancers. Please submit your quote within <strong>24 hours</strong>.</p>` +
    eSectionLabel('Property Details') +
    eDataTable([
      ['Address', body.propertyAddress || 'Not provided'],
      ['Price', fmtPrice(body.propertyValue)],
      ['Type', body.propertyType || 'Not specified'],
      ['Freehold / Leasehold', body.freehold || 'Not specified'],
      ['New build', body.newBuild === 'yes' ? 'Yes' : 'No'],
      ['Transaction', tx],
    ]) +
    eInfoBox('This referral has been sent to a small number of firms. First to submit a competitive quote wins. The client&rsquo;s contact details are shared only if they select your quote.');
  return emailWrap({
    badge: { text: 'New Referral', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'You have a new<br>conveyancing referral',
    sub: 'A prospective client is waiting for a quote. Review the details below and submit yours.',
    content,
    cta: { label: 'Submit Your Quote', href: quoteLink },
  });
}

function emailConsumerQuotesReady(lead, propertyAddress, leadUuid, quotes) {
  const compareLink = `https://findconveyancers.co.uk/compare.html?lead=${leadUuid}`;
  const cards = (quotes && quotes.length)
    ? eQuoteCards(quotes.map(q => ({ firm: q.firm_name, meta: 'Fixed fee', price: fmt(q.total_quote) })))
    : '';
  const content =
    eSectionLabel('Your Quotes') + cards +
    `<div style="font-size:10px;color:#9CA3AF;line-height:1.65;margin-bottom:22px;">Prices shown are each firm&rsquo;s legal fee. Full breakdowns including VAT and disbursements are provided by the firm when you select them.</div>`;
  return emailWrap({
    badge: { text: 'Quotes Ready', bg: '#F0FDF4', color: '#166534' },
    headline: 'Your conveyancing quotes<br>are ready to compare',
    sub: 'We&rsquo;ve matched you with regulated solicitors based on your property and location. All firms are SRA or CLC regulated, so you can compare and choose with no obligation.',
    content,
    cta: { label: 'Compare Your Quotes', href: compareLink },
    refer: { url: `https://findconveyancers.co.uk/?ref=${leadUuid}` },
  });
}

function emailConveyancerInstructed(lead, quote, propertyAddress) {
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">${lead.first_name} ${lead.last_name} has instructed your firm for conveyancing at <strong>${propertyAddress}</strong>.</p>` +
    eSectionLabel('Client Contact Details') +
    eDataTable([
      ['Name', `${lead.first_name} ${lead.last_name}`],
      ['Email', lead.email],
      ['Phone', lead.phone || 'Not provided'],
    ]) +
    eSectionLabel('Property &amp; Quote') +
    eDataTable([
      ['Address', propertyAddress],
      ['Your quote', fmt(quote.total_quote)],
    ]) +
    eInfoBox('This is now your client, so please don&rsquo;t pass their details to any third party. Contact them within 24 hours to introduce yourself.');
  return emailWrap({
    badge: { text: 'You&rsquo;ve Been Instructed', bg: '#F0FDF4', color: '#166534' },
    headline: 'Congratulations,<br>you&rsquo;ve been chosen',
    sub: `${lead.first_name} has selected your firm. Their full contact details are below so you can get started.`,
    content,
  });
}

function emailConsumerConfirmed(lead, quote, propertyAddress) {
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">You&rsquo;ve chosen <strong>${quote.firm_name}</strong> for your conveyancing at <strong>${propertyAddress}</strong>. They&rsquo;ll be in touch within 24 hours to get things started.</p>` +
    eSectionLabel('Your Conveyancer') +
    eDataTable([
      ['Firm', quote.firm_name],
      ['Email', quote.conveyancer_email],
      ['Phone', quote.conveyancer_phone || 'Not provided'],
      ['Your quote', fmt(quote.total_quote)],
    ]) +
    eSectionLabel('What Happens Next') +
    eSteps([
      { title: 'They&rsquo;ll confirm your instruction', desc: `${quote.firm_name} will contact you to confirm and send a client care letter with their terms.` },
      { title: 'Provide your ID', desc: 'You&rsquo;ll be asked for identity documents to satisfy anti-money-laundering checks.' },
      { title: 'The conveyancing begins', desc: 'From here it typically takes 8&ndash;12 weeks through to completion.' },
    ]);
  return emailWrap({
    badge: { text: 'You&rsquo;re All Set', bg: '#F0FDF4', color: '#166534' },
    headline: `${quote.firm_name}<br>will contact you shortly`,
    sub: 'Your conveyancer is confirmed. Here&rsquo;s everything you need to know about what comes next.',
    content,
    refer: { url: `https://findconveyancers.co.uk/?ref=${lead.id}` },
  });
}

function emailAdminNewLead(body, leadUuid) {
  const content = eSectionLabel('Lead Details') + eDataTable([
    ['Name', `${body.firstName} ${body.lastName}`],
    ['Email', body.email],
    ['Phone', body.phone],
    ['Property', body.propertyAddress || body.city || 'Not specified'],
    ['Price', fmtPrice(body.propertyValue)],
    ['Lead ID', `<span style="font-family:'Courier New',monospace;font-size:11px;">${leadUuid}</span>`],
  ]);
  return emailWrap({
    badge: { text: 'New Lead', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'New lead received',
    sub: 'A new consumer quote request has come in.',
    content,
    cta: { label: 'View Admin Dashboard', href: 'https://findconveyancers.co.uk/admin.html' },
  });
}

function emailAdminInstruction(lead, quote, propertyAddress, agent) {
  const rows = [
    ['Consumer', `${lead.first_name} ${lead.last_name}`],
    ['Property', propertyAddress],
    ['Conveyancer', quote.firm_name],
    ['Quote', fmt(quote.total_quote)],
  ];
  if (agent) rows.push(['Agent', agent.name]);
  return emailWrap({
    badge: { text: 'New Instruction', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'New instruction',
    sub: 'A consumer has instructed a conveyancer.',
    content: eSectionLabel('Instruction Details') + eDataTable(rows),
    cta: { label: 'View Admin Dashboard', href: 'https://findconveyancers.co.uk/admin.html' },
  });
}

function emailAgentInstruction(lead, quote, propertyAddress, agent) {
  const referralFee = agent?.fee_per_lead ? fmt(agent.fee_per_lead) : '£0';
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">Good news, ${agent.name}. A client you referred has instructed a conveyancer.</p>` +
    eSectionLabel('Referral Details') +
    eDataTable([
      ['Client', `${lead.first_name} ${lead.last_name}`],
      ['Property', propertyAddress],
      ['Conveyancer', quote.firm_name],
      ['Quote', fmt(quote.total_quote)],
      ['Your referral fee', `${referralFee} (paid after completion)`],
    ]) +
    eInfoBox('A referral fee becomes due once the transaction completes, and we&rsquo;ll handle it automatically with no invoicing needed.');
  return emailWrap({
    partner: true,
    badge: { text: 'Referral Instructed', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'Your referral<br>has been instructed',
    sub: `${lead.first_name} ${lead.last_name} has chosen a conveyancer through your link.`,
    content,
    cta: { label: 'View Your Partner Dashboard', href: 'https://findconveyancers.co.uk/agent.html' },
  });
}

// ── New: conveyancer partner welcome (includes their agreement record) ─────────
function emailConveyancerWelcome(conv, agreementHtml) {
  const name = conv.contact_name || conv.name || 'there';
  const delivery = conv.delivery_email || conv.email;
  let content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">Welcome aboard, ${name}. Here&rsquo;s how being a FindConveyancers partner works.</p>` +
    eSectionLabel('How It Works') +
    eChecks([
      { title: 'Referrals arrive by email', desc: `We email each new referral to ${delivery} with a unique link to submit your quote. No dashboard and no login to remember.` },
      { title: 'Win the work, get the details', desc: 'If the client selects you, we email you their full contact details so you can proceed directly.' },
      { title: 'Pay on completion only', desc: 'A referral fee is due only when the matter completes, never at instruction, and never if a transaction falls through.' },
    ], 'green') +
    eInfoBox('Tip: add noreply@findconveyancers.co.uk to your safe-senders list so you never miss a referral.');
  if (agreementHtml) {
    content += `<div style="border-top:1px solid #E5E7EB;margin-top:6px;padding-top:18px;">${agreementHtml}</div>`;
  }
  return emailWrap({
    badge: { text: 'Partner Confirmed', bg: '#F0FDF4', color: '#166534' },
    headline: 'You&rsquo;re now a<br>FindConveyancers partner',
    sub: 'Your firm is registered and your acceptance of our Referral Supply Agreement is confirmed. A copy is included below for your records.',
    content,
  });
}

// ── New: estate agent partner welcome (Template 3) ─────────────────────────────
function emailEstateAgentWelcome(agent) {
  const refUrl = `https://findconveyancers.co.uk/?ref=${agent.id}`;
  const content =
    eSectionLabel('Your Referral Link') +
    eReferralBox(refUrl) +
    eSectionLabel('3 Ways to Share It') +
    eChecks([
      { title: 'Send to buyers &amp; sellers', desc: 'Share your link the moment a sale is agreed, and clients can request quotes in under 60 seconds.' },
      { title: 'Add to your email signature', desc: 'A single line with your referral link works quietly in the background across every email you send.' },
      { title: 'Feature on your website', desc: 'We&rsquo;ll provide a branded widget or simple button you can drop onto your site in minutes.' },
    ], 'green') +
    `<div style="border-top:1px solid #E5E7EB;padding-top:14px;font-size:11px;color:#6B7280;line-height:1.5;">Questions? Reply to this email or contact <a href="mailto:partners@findconveyancers.co.uk" style="color:#3B82F6;font-weight:600;text-decoration:none;">partners@findconveyancers.co.uk</a></div>`;
  return emailWrap({
    partner: true,
    badge: { text: 'Partner Programme', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'Welcome to the<br>FindConveyancers<br>Partner Programme',
    sub: 'Your referral link is active and ready to share. Earn a fee for every conveyancing transaction that completes through your link, automatically and with no invoicing.',
    content,
    cta: { label: 'View Your Partner Dashboard', href: 'https://findconveyancers.co.uk/agent.html' },
    dark: {
      label: 'How Your Earnings Work',
      items: [
        'A referral fee is paid for every transaction that completes through your link',
        'Payments are automatic, with no invoicing, chasing or admin required',
        'Your dashboard shows referrals, quote requests, and completions in real time',
      ],
    },
  });
}

// ── New: estate agent monthly summary (Template 4) ─────────────────────────────
function emailEstateAgentMonthlySummary(agent, stats) {
  const content =
    eSectionLabel(`${stats.month} ${stats.year} at a Glance`) +
    eStatsGrid([
      { label: 'Referrals sent',      value: String(stats.referrals),   delta: stats.deltaReferrals,   up: stats.deltaReferralsUp },
      { label: 'Quotes requested',    value: String(stats.quotes),      delta: stats.deltaQuotes,      up: stats.deltaQuotesUp },
      { label: 'Completions',         value: String(stats.completions), delta: stats.deltaCompletions, up: stats.deltaCompletionsUp },
      { label: 'Earnings this month', value: stats.earnings,            delta: stats.deltaEarnings,    up: stats.deltaEarningsUp },
    ]) +
    eInfoBox('Agents who share their link at offer acceptance see 3&times; more referrals. Try adding it to your sale-agreed email.');
  return emailWrap({
    partner: true,
    badge: { text: `Monthly Summary &middot; ${stats.month} ${stats.year}`, bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'Your referral activity<br>this month',
    sub: `Here&rsquo;s a summary of your FindConveyancers partner performance for ${stats.month} ${stats.year}.`,
    content,
    cta: { label: 'View Full Report', href: 'https://findconveyancers.co.uk/agent.html' },
  });
}

// ── New: conveyancer not selected ──────────────────────────────────────────────
function emailConveyancerNotSelected(conv, lead, propertyAddress) {
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 12px;">Thanks for quoting on the conveyancing referral at <strong>${propertyAddress}</strong>. On this occasion the client has chosen another firm.</p>` +
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">It&rsquo;s nothing about your quote; clients weigh up several factors. We send referrals out regularly, so there&rsquo;ll be more opportunities soon.</p>` +
    eInfoBox('No action needed. We&rsquo;ll be in touch with your next referral.');
  return emailWrap({
    badge: { text: 'Referral Update', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'Not selected this time',
    sub: 'The client has instructed another firm for this referral.',
    content,
  });
}

// ── New: estate agent, a referred client has entered the system ───────────────
function emailEstateAgentReferralSubmitted(agent, lead) {
  const received = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">Good news, ${agent.name}. A client you referred has just requested conveyancing quotes through your link.</p>` +
    eSectionLabel('Referral Received') +
    eDataTable([
      ['Client', `${lead.first_name} ${lead.last_name}`],
      ['Property', lead.property_address || lead.postcode || 'Not specified'],
      ['Received', received],
    ]) +
    eInfoBox('We&rsquo;ll let you know if this referral goes on to instruct a conveyancer. That&rsquo;s when your fee is earned.');
  return emailWrap({
    partner: true,
    badge: { text: 'New Referral', bg: '#F0FDF4', color: '#166534' },
    headline: 'Your referral is in',
    sub: 'A client you referred has entered the FindConveyancers process.',
    content,
    cta: { label: 'View Your Partner Dashboard', href: 'https://findconveyancers.co.uk/agent.html' },
  });
}

// ── New: consumer, first quote has arrived ────────────────────────────────────
function emailConsumerFirstQuoteArrived(lead) {
  const compareLink = `https://findconveyancers.co.uk/compare.html?lead=${lead.id}`;
  const address = lead.property_address || lead.postcode || 'your property';
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">Hi ${lead.first_name}, your first conveyancing quote for <strong>${address}</strong> has just arrived, with more likely to follow shortly.</p>` +
    eInfoBox('We&rsquo;ll keep collecting quotes so you can compare them side by side. There&rsquo;s no obligation and it&rsquo;s completely free.');
  return emailWrap({
    badge: { text: 'First Quote In', bg: '#F0FDF4', color: '#166534' },
    headline: 'Your first quote<br>has arrived',
    sub: 'One regulated firm has already quoted on your property. View it now or wait for the full comparison.',
    content,
    cta: { label: 'View Your Quote', href: compareLink },
    refer: { url: `https://findconveyancers.co.uk/?ref=${lead.id}` },
  });
}

// ── New: admin notice of a conveyancer signup ─────────────────────────────────
function emailAdminNewConveyancer(name, detailsTable, agreedDate, agreementVersion, id) {
  const content =
    `<p style="font-size:12.5px;color:#374151;line-height:1.6;margin:0 0 16px;">A new firm has applied to join FindConveyancers and accepted the Referral Supply Agreement.</p>` +
    eSectionLabel('Firm Details') + detailsTable +
    eDataTable([
      ['Agreed at', agreedDate],
      ['Agreement version', agreementVersion],
      ['Reference', `<span style="font-family:'Courier New',monospace;font-size:11px;">${id}</span>`],
    ]);
  return emailWrap({
    badge: { text: 'New Conveyancer', bg: '#EFF6FF', color: '#1D4ED8' },
    headline: 'New conveyancer signup',
    sub: `${name} has applied to join and accepted the Referral Supply Agreement.`,
    content,
    cta: { label: 'Activate in Admin Dashboard', href: 'https://findconveyancers.co.uk/admin.html' },
  });
}

// ── JSON helper ────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
