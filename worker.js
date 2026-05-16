/**
 * FindConveyancers – Cloudflare Worker
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

      // ── Admin ───────────────────────────────────────────────────────────────
      if (path === '/api/admin/login' && request.method === 'POST')
        return handleAdminLogin(request, env);

      if (path === '/api/admin/leads' && request.method === 'GET')
        return handleGetLeads(request, env);

      if (path.startsWith('/api/admin/leads/') && request.method === 'PATCH')
        return handleUpdateLead(request, env, path.split('/').pop());

      if (path === '/api/admin/stats' && request.method === 'GET')
        return handleGetStats(request, env);

      if (path === '/api/admin/conveyancers' && request.method === 'GET')
        return handleGetConveyancers(request, env);

      if (path === '/api/admin/conveyancers' && request.method === 'POST')
        return handleAddConveyancer(request, env);

      if (path === '/api/admin/agents' && request.method === 'POST')
        return handleAddAgent(request, env);

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
  const body = await request.json();

  const required = ['firstName', 'lastName', 'email', 'phone'];
  for (const field of required) {
    if (!body[field]) return jsonResponse({ error: `Missing field: ${field}` }, 400);
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  // Save to consumer-facing quotes table (FindConveyancers)
  await env.DB.prepare(`
    INSERT INTO quotes (
      id, city, property_address, property_price, property_type,
      freehold_leasehold, new_build, transaction_type,
      first_name, last_name, email, phone,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
  `).bind(
    id,
    body.city || '',
    body.propertyAddress || '',
    body.propertyValue || 0,
    body.propertyType || '',
    body.freehold || '',
    body.newBuild || 'no',
    Array.isArray(body.transactionTypes) ? body.transactionTypes[0] : (body.transactionType || ''),
    body.firstName, body.lastName,
    body.email.toLowerCase(), body.phone,
    now, now
  ).run();

  // Save to leads table (pipeline tracking)
  await env.DB.prepare(`
    INSERT INTO leads (
      id, agent_ref, agent_name,
      transaction_types, property_type, property_value,
      postcode, timeline,
      first_name, last_name, email, phone,
      status, created_at, updated_at,
      instructed_conveyancer_id, quotes_sent_at, instructed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, '', '', '')
  `).bind(
    id,
    'findconveyancers',
    'FindConveyancers',
    JSON.stringify(body.transactionTypes || [body.transactionType] || []),
    body.propertyType  || '',
    body.propertyValue || 0,
    body.city || body.postcode || 'UK',
    body.timeline  || '',
    body.firstName, body.lastName,
    body.email.toLowerCase(), body.phone,
    now, now
  ).run();

  // Email all active conveyancers + admin
  await Promise.all([
    emailConveyancers(body, id, env),
    sendEmail(env.NOTIFY_EMAIL, `New lead: ${body.firstName} ${body.lastName}`, emailAdminNewLead(body, id), env),
  ]);

  return jsonResponse({ success: true, quoteId: id }, 201);
}

// ── Get lead details (for quote.html + compare.html) ─────────────────────────
async function handleGetLead(request, env) {
  const uuid = new URL(request.url).searchParams.get('uuid');
  if (!uuid) return jsonResponse({ error: 'Missing uuid' }, 400);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(uuid).first();
  if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

  // Property address lives in the quotes table (same UUID)
  const qr = await env.DB.prepare('SELECT property_address FROM quotes WHERE id = ?').bind(uuid).first();

  return jsonResponse({
    id:               lead.id,
    property_address: qr?.property_address || lead.postcode,
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

  const qr = await env.DB.prepare('SELECT property_address FROM quotes WHERE id = ?').bind(leadUuid).first();

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
      property_address: qr?.property_address || lead.postcode,
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

  // When 3+ quotes received, email consumer the comparison link
  if (count >= 3 && lead.status === 'new') {
    await env.DB.prepare(
      'UPDATE leads SET status = ?, quotes_sent_at = ?, updated_at = ? WHERE id = ?'
    ).bind('quotes_sent', now, now, lead_uuid).run();

    const qr = await env.DB.prepare('SELECT property_address FROM quotes WHERE id = ?').bind(lead_uuid).first();
    await sendEmail(
      lead.email,
      'Your conveyancing quotes are ready',
      emailConsumerQuotesReady(lead, qr?.property_address || lead.postcode, lead_uuid),
      env
    );
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
  const qr  = await env.DB.prepare('SELECT property_address FROM quotes WHERE id = ?').bind(lead_uuid).first();
  const propertyAddress = qr?.property_address || lead.postcode;

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

  // Fire all notification emails
  await Promise.all([
    sendEmail(quote.conveyancer_email,
      `Client instructed you – ${lead.first_name} ${lead.last_name}`,
      emailConveyancerInstructed(lead, quote, propertyAddress), env),
    sendEmail(lead.email,
      `${quote.firm_name} will contact you`,
      emailConsumerConfirmed(lead, quote, propertyAddress), env),
    sendEmail(env.NOTIFY_EMAIL,
      `New instruction – ${lead.first_name} ${lead.last_name}`,
      emailAdminInstruction(lead, quote, propertyAddress, agent), env),
    agent ? sendEmail(agent.email,
      `Your referral instructed – ${lead.first_name} ${lead.last_name}`,
      emailAgentInstruction(lead, quote, propertyAddress, agent), env) : Promise.resolve(),
  ]);

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

// ── Admin: stats ───────────────────────────────────────────────────────────────
async function handleGetStats(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const [total, byStatus, recent, quoteCount, instructedCount] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM leads').first(),
    env.DB.prepare('SELECT status, COUNT(*) AS cnt FROM leads GROUP BY status').all(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM leads WHERE created_at > datetime("now","-7 days")').first(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM conveyancer_quotes').first(),
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM leads WHERE status = "instructed"').first(),
  ]);

  return jsonResponse({
    total:        total.cnt,
    thisWeek:     recent.cnt,
    totalQuotes:  quoteCount.cnt,
    instructed:   instructedCount.cnt,
    byStatus:     byStatus.results,
  });
}

// ── Admin: list conveyancers ───────────────────────────────────────────────────
async function handleGetConveyancers(request, env) {
  if (!isAdminAuthorized(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    'SELECT * FROM conveyancers ORDER BY name ASC'
  ).all();

  return jsonResponse({ conveyancers: results });
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
async function sendEmail(to, subject, html, env) {
  if (!to || !env.RESEND_API_KEY) {
    console.warn('sendEmail skipped – no recipient or no RESEND_API_KEY');
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'FindConveyancers <quotes@findconveyancers.co.uk>',
        to:      Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });
    if (!res.ok) console.error('Resend error:', res.status, await res.text());
  } catch (e) {
    console.error('Email failed:', e.message);
  }
}

// ── Email all active conveyancers when a new lead arrives ──────────────────────
async function emailConveyancers(body, leadUuid, env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM conveyancers WHERE active = 1'
  ).all();

  await Promise.all(results.map(conv => {
    const quoteLink = `https://findconveyancers.co.uk/quote.html?lead=${leadUuid}&conv=${conv.id}`;
    return sendEmail(conv.email,
      `New quote request – ${body.propertyType || 'Property'} at £${(parseInt(body.propertyValue)||0).toLocaleString('en-GB')}`,
      emailConveyancerNewLead(body, leadUuid, conv, quoteLink),
      env
    );
  }));
}

// ── Email templates ────────────────────────────────────────────────────────────
function emailWrap(title, content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{margin:0;padding:0;background:#f4f4f5;font-family:'Helvetica Neue',Arial,sans-serif;color:#111827}
    .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb}
    .hdr{background:#2563eb;padding:28px 32px;color:#fff}
    .hdr h1{margin:0;font-size:20px;font-weight:700;letter-spacing:-0.3px}
    .hdr p{margin:6px 0 0;font-size:13px;opacity:.85}
    .body{padding:32px}
    .body h2{font-size:16px;font-weight:700;color:#111827;margin:0 0 8px}
    .body p{font-size:14px;color:#374151;line-height:1.6;margin:0 0 14px}
    table.data{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
    table.data td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#374151}
    table.data td:first-child{font-weight:600;color:#111827;width:42%;white-space:nowrap}
    .btn{display:inline-block;background:#2563eb;color:#fff;font-weight:700;font-size:14px;padding:14px 28px;border-radius:8px;text-decoration:none;margin:16px 0}
    .btn-green{background:#059669}
    .note{background:#f9fafb;border-left:3px solid #d1d5db;padding:12px 16px;border-radius:4px;font-size:13px;color:#6b7280;margin:16px 0}
    .ftr{padding:20px 32px;font-size:12px;color:#9ca3af;border-top:1px solid #f3f4f6;text-align:center}
  </style></head><body>
  <div class="wrap">
    <div class="hdr"><h1>FindConveyancers</h1><p>${title}</p></div>
    <div class="body">${content}</div>
    <div class="ftr">FindConveyancers &bull; findconveyancers.co.uk &bull; All firms are SRA or CLC regulated</div>
  </div></body></html>`;
}

function fmt(pence) { return '£' + (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPrice(p) { return '£' + parseInt(p || 0).toLocaleString('en-GB'); }

function emailConveyancerNewLead(body, leadUuid, conv, quoteLink) {
  const price = fmtPrice(body.propertyValue);
  const tx    = Array.isArray(body.transactionTypes) ? body.transactionTypes.join(', ') : (body.transactionType || 'Not specified');
  return emailWrap('New conveyancing quote request', `
    <h2>New Quote Request</h2>
    <p>Hi ${conv.name},</p>
    <p>You have a new lead from FindConveyancers. Please submit your quote within <strong>24 hours</strong>.</p>
    <h2 style="margin-top:20px">Property Details</h2>
    <table class="data">
      <tr><td>Address</td><td>${body.propertyAddress || 'Not provided'}</td></tr>
      <tr><td>Price</td><td>${price}</td></tr>
      <tr><td>Type</td><td>${body.propertyType || 'Not specified'}</td></tr>
      <tr><td>Freehold / Leasehold</td><td>${body.freehold || 'Not specified'}</td></tr>
      <tr><td>New Build</td><td>${body.newBuild === 'yes' ? 'Yes' : 'No'}</td></tr>
      <tr><td>Transaction</td><td>${tx}</td></tr>
      <tr><td>First-time buyer</td><td>${body.firstTimeBuyer === 'yes' ? 'Yes' : 'No'}</td></tr>
    </table>
    <h2>Client Details</h2>
    <table class="data">
      <tr><td>Name</td><td>${body.firstName} ${body.lastName}</td></tr>
      <tr><td>Email</td><td>${body.email}</td></tr>
      <tr><td>Phone</td><td>${body.phone || 'Not provided'}</td></tr>
    </table>
    <a href="${quoteLink}" class="btn">Submit Your Quote</a>
    <div class="note">This lead has been sent to a small number of firms. First to submit a competitive quote wins.</div>
  `);
}

function emailConsumerQuotesReady(lead, propertyAddress, leadUuid) {
  const compareLink = `https://findconveyancers.co.uk/compare.html?lead=${leadUuid}`;
  return emailWrap('Your conveyancing quotes are ready', `
    <h2>Your quotes are ready to compare</h2>
    <p>Hi ${lead.first_name},</p>
    <p>You've received conveyancing quotes for <strong>${propertyAddress}</strong>. Compare them side-by-side and choose the firm that's right for you.</p>
    <p>All firms are regulated by the SRA or CLC and have been vetted by FindConveyancers.</p>
    <a href="${compareLink}" class="btn">Compare My Quotes</a>
    <div class="note">Simply click the button above to see all quotes and choose your conveyancer. There is no obligation and it is completely free.</div>
  `);
}

function emailConveyancerInstructed(lead, quote, propertyAddress) {
  return emailWrap('You have been instructed', `
    <h2>Congratulations – you've been chosen!</h2>
    <p>${lead.first_name} ${lead.last_name} has instructed your firm for conveyancing at <strong>${propertyAddress}</strong>.</p>
    <h2 style="margin-top:20px">Client Contact Details</h2>
    <table class="data">
      <tr><td>Name</td><td>${lead.first_name} ${lead.last_name}</td></tr>
      <tr><td>Email</td><td>${lead.email}</td></tr>
      <tr><td>Phone</td><td>${lead.phone || 'Not provided'}</td></tr>
    </table>
    <h2>Property Details</h2>
    <table class="data">
      <tr><td>Address</td><td>${propertyAddress}</td></tr>
      <tr><td>Your quote</td><td>${fmt(quote.total_quote)}</td></tr>
    </table>
    <h2>Next Steps</h2>
    <p>1. Contact ${lead.first_name} within 24 hours to introduce yourself.<br>
       2. Send your instruction letter / client care letter.<br>
       3. Begin the conveyancing process.</p>
    <div class="note">This is now your client. Please do not pass their details to any third party.</div>
  `);
}

function emailConsumerConfirmed(lead, quote, propertyAddress) {
  return emailWrap('Your conveyancer is confirmed', `
    <h2>${quote.firm_name} will contact you shortly</h2>
    <p>Hi ${lead.first_name},</p>
    <p>You've chosen <strong>${quote.firm_name}</strong> for your conveyancing at <strong>${propertyAddress}</strong>.</p>
    <p>They will contact you within 24 hours to get things started.</p>
    <h2 style="margin-top:20px">Your Conveyancer</h2>
    <table class="data">
      <tr><td>Firm</td><td>${quote.firm_name}</td></tr>
      <tr><td>Email</td><td>${quote.conveyancer_email}</td></tr>
      <tr><td>Phone</td><td>${quote.conveyancer_phone || 'Not provided'}</td></tr>
      <tr><td>Your quote</td><td>${fmt(quote.total_quote)}</td></tr>
    </table>
    <h2>What happens next?</h2>
    <p>1. ${quote.firm_name} will contact you to confirm your instruction.<br>
       2. They'll send you a client care letter with their terms.<br>
       3. You'll need to provide ID documents.<br>
       4. Conveyancing typically takes 8–12 weeks.</p>
    <div class="note">If you have any issues, reply to this email and we'll help.</div>
  `);
}

function emailAdminNewLead(body, leadUuid) {
  const adminLink = `https://findconveyancers.co.uk/admin.html`;
  return emailWrap('New lead received', `
    <h2>New Lead</h2>
    <table class="data">
      <tr><td>Name</td><td>${body.firstName} ${body.lastName}</td></tr>
      <tr><td>Email</td><td>${body.email}</td></tr>
      <tr><td>Phone</td><td>${body.phone}</td></tr>
      <tr><td>Property</td><td>${body.propertyAddress || body.city || 'Not specified'}</td></tr>
      <tr><td>Price</td><td>${fmtPrice(body.propertyValue)}</td></tr>
      <tr><td>Lead ID</td><td style="font-family:monospace;font-size:12px">${leadUuid}</td></tr>
    </table>
    <a href="${adminLink}" class="btn">View Admin Dashboard</a>
  `);
}

function emailAdminInstruction(lead, quote, propertyAddress, agent) {
  return emailWrap('New instruction', `
    <h2>New Instruction</h2>
    <table class="data">
      <tr><td>Consumer</td><td>${lead.first_name} ${lead.last_name}</td></tr>
      <tr><td>Property</td><td>${propertyAddress}</td></tr>
      <tr><td>Conveyancer</td><td>${quote.firm_name}</td></tr>
      <tr><td>Quote</td><td>${fmt(quote.total_quote)}</td></tr>
      ${agent ? `<tr><td>Agent</td><td>${agent.name}</td></tr>` : ''}
    </table>
    <a href="https://findconveyancers.co.uk/admin.html" class="btn">View Admin Dashboard</a>
  `);
}

function emailAgentInstruction(lead, quote, propertyAddress, agent) {
  const referralFee = agent?.fee_per_lead ? fmt(agent.fee_per_lead) : '£0';
  return emailWrap('Your referral has been instructed', `
    <h2>Referral Instructed</h2>
    <p>Hi ${agent.name},</p>
    <p>${lead.first_name} ${lead.last_name} chose ${quote.firm_name} (${fmt(quote.total_quote)}) for ${propertyAddress}.</p>
    <table class="data">
      <tr><td>Consumer</td><td>${lead.first_name} ${lead.last_name}</td></tr>
      <tr><td>Conveyancer</td><td>${quote.firm_name}</td></tr>
      <tr><td>Quote</td><td>${fmt(quote.total_quote)}</td></tr>
      <tr><td>Your referral fee</td><td>${referralFee} (paid 7 days after completion)</td></tr>
    </table>
    <div class="note">Expected completion: approximately 8–12 weeks.</div>
  `);
}

// ── JSON helper ────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
