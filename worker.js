/**
 * ConveySelect - Cloudflare Worker
 * Handles: lead submission, lead retrieval, status updates, admin auth, agent auth
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
      // ── Public ──
      if (path === '/api/leads' && request.method === 'POST') {
        return await handleLeadSubmission(request, env);
      }

      // ── Admin ──
      if (path === '/api/admin/login' && request.method === 'POST') {
        return await handleAdminLogin(request, env);
      }
      if (path === '/api/admin/leads' && request.method === 'GET') {
        return await handleGetLeads(request, env);
      }
      if (path.startsWith('/api/admin/leads/') && request.method === 'PATCH') {
        return await handleUpdateLead(request, env, path.split('/').pop());
      }
      if (path === '/api/admin/stats' && request.method === 'GET') {
        return await handleGetStats(request, env);
      }
      if (path === '/api/admin/agents' && request.method === 'POST') {
  return await handleAddAgent(request, env);
}

      // ── Agent ──
      if (path === '/api/agent/login' && request.method === 'POST') {
        return await handleAgentLogin(request, env);
      }
      if (path === '/api/agent/me' && request.method === 'GET') {
        return await handleAgentMe(request, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};

// ── Submit a new lead ──────────────────────────────────────────────────────
async function handleLeadSubmission(request, env) {
  const body = await request.json();

  const required = ['firstName', 'lastName', 'email', 'phone', 'postcode'];
  for (const field of required) {
    if (!body[field]) return jsonResponse({ error: `Missing field: ${field}` }, 400);
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO leads (
      id, agent_ref, agent_name,
      transaction_types, property_type, property_value,
      postcode, timeline,
      first_name, last_name, email, phone,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
  `).bind(
    id,
    body.agentRef  || 'direct',
    body.agentName || 'Direct',
    JSON.stringify(body.transactionTypes || []),
    body.propertyType  || '',
    body.propertyValue || 0,
    body.postcode.toUpperCase(),
    body.timeline  || '',
    body.firstName,
    body.lastName,
    body.email.toLowerCase(),
    body.phone,
    now, now
  ).run();

  await sendNotifications(body, id, env);
  return jsonResponse({ success: true, leadId: id }, 201);
}

// ── Admin login ────────────────────────────────────────────────────────────
async function handleAdminLogin(request, env) {
  const body = await request.json();
  if (body.password === env.ADMIN_PASSWORD) {
    return jsonResponse({ success: true, token: env.ADMIN_PASSWORD });
  }
  return jsonResponse({ error: 'Invalid password' }, 401);
}

// ── Get all leads (admin) ──────────────────────────────────────────────────
async function handleGetLeads(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url      = new URL(request.url);
  const status   = url.searchParams.get('status');
  const agentRef = url.searchParams.get('agent');
  const limit    = parseInt(url.searchParams.get('limit')  || '50');
  const offset   = parseInt(url.searchParams.get('offset') || '0');

  let query      = 'SELECT * FROM leads';
  const conditions = [];
  const params     = [];

  if (status)   { conditions.push('status = ?');    params.push(status); }
  if (agentRef) { conditions.push('agent_ref = ?'); params.push(agentRef); }

  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...params).all();

  const leads = results.map(lead => ({
    ...lead,
    transaction_types: JSON.parse(lead.transaction_types || '[]')
  }));

  return jsonResponse({ leads, total: leads.length });
}

// ── Update lead (admin) ────────────────────────────────────────────────────
async function handleUpdateLead(request, env, id) {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body    = await request.json();
  const allowed = ['new', 'contacted', 'converted', 'lost'];

  if (!allowed.includes(body.status)) {
    return jsonResponse({ error: 'Invalid status' }, 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE leads SET status = ?, notes = ?, updated_at = ? WHERE id = ?
  `).bind(body.status, body.notes || '', now, id).run();

  return jsonResponse({ success: true });
}
// ── Add agent (admin) ──────────────────────────────────────────────────────────
async function handleAddAgent(request, env) {
  if (!isAdminAuthorized(request, env)) {        // ← Fixed
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await request.json();
    
    if (!body.ref || !body.name || !body.email) {
      return jsonResponse({ error: 'Missing required fields (ref, name, email)' }, 400);
    }

    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO agents (
        id, ref, name, email, phone, 
        fee_per_lead, active, created_at, password
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      body.id || crypto.randomUUID(),
      body.ref.toLowerCase().trim(),
      body.name.trim(),
      body.email.trim().toLowerCase(),
      body.phone || '',
      body.fee_per_lead || 0,
      now,
      body.password || 'temp123'   // You should improve this later
    ).run();

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Add agent error:', err);
    return jsonResponse({ error: 'Failed to add agent', details: err.message }, 500);
  }
}
// ── Stats (admin) ──────────────────────────────────────────────────────────
async function handleGetStats(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const [total, byStatus, byAgent, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as count FROM leads').first(),
    env.DB.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all(),
    // Updated: Query from agents table first to include those with 0 leads
    env.DB.prepare(`
      SELECT 
        a.ref as agent_ref, 
        a.name as agent_name, 
        COUNT(l.id) as count 
      FROM agents a
      LEFT JOIN leads l ON a.ref = l.agent_ref
      GROUP BY a.ref, a.name
      ORDER BY count DESC
    `).all(),
    env.DB.prepare('SELECT COUNT(*) as count FROM leads WHERE created_at > datetime("now", "-7 days")').first(),
  ]);

  return jsonResponse({
    total:    total.count,
    thisWeek: recent.count,
    byStatus: byStatus.results,
    byAgent:  byAgent.results,
  });
}

// ── Agent login ────────────────────────────────────────────────────────────
async function handleAgentLogin(request, env) {
  const body = await request.json();

  if (!body.ref || !body.password) {
    return jsonResponse({ error: 'Missing ref or password' }, 400);
  }

  // Look up agent by ref
  const agent = await env.DB.prepare(
    'SELECT * FROM agents WHERE ref = ? AND active = 1'
  ).bind(body.ref).first();

  if (!agent) {
    return jsonResponse({ error: 'Invalid credentials' }, 401);
  }

  // Compare password (stored as plain text for now — upgrade to hashed later)
  if (body.password !== agent.password) {
    return jsonResponse({ error: 'Invalid credentials' }, 401);
  }

  // Token is ref:password base64 encoded — simple, stateless
  const token = btoa(`${agent.ref}:${agent.password}`);
  return jsonResponse({ success: true, token, agentRef: agent.ref });
}

// ── Agent: get own data ────────────────────────────────────────────────────
async function handleAgentMe(request, env) {
  const agent = await getAgentFromToken(request, env);
  if (!agent) return jsonResponse({ error: 'Unauthorized' }, 401);

  // Agent info
  const agentInfo = {
    ref:        agent.ref,
    name:       agent.name,
    email:      agent.email,
    feePerLead: agent.fee_per_lead,
  };

  // Their leads (anonymised — no full email/phone)
  const { results } = await env.DB.prepare(`
    SELECT
      id, transaction_types, property_type, property_value,
      postcode, timeline, first_name, last_name,
      status, created_at
    FROM leads
    WHERE agent_ref = ?
    ORDER BY created_at DESC
  `).bind(agent.ref).all();

  const leads = results.map(l => ({
    ...l,
    transaction_types: JSON.parse(l.transaction_types || '[]')
  }));

  // Earnings summary
  const converted   = leads.filter(l => l.status === 'converted').length;
  const feePerLead  = agent.fee_per_lead || 0;
  const totalEarned = converted * feePerLead;

  // Stats
  const byStatus = ['new','contacted','converted','lost'].map(s => ({
    status: s,
    count:  leads.filter(l => l.status === s).length
  }));

  return jsonResponse({
    agent:      agentInfo,
    leads,
    earnings: {
      feePerLead,
      totalEarned,
      converted,
      paid:    0, // extend later with a payments table
      pending: totalEarned,
    },
    byStatus,
  });
}

// ── Auth helpers ───────────────────────────────────────────────────────────
function isAdminAuthorized(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

async function getAgentFromToken(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;

  try {
    const decoded = atob(token);
    const [ref, password] = decoded.split(':');
    const agent = await env.DB.prepare(
      'SELECT * FROM agents WHERE ref = ? AND active = 1'
    ).bind(ref).first();

    if (!agent || agent.password !== password) return null;
    return agent;
  } catch {
    return null;
  }
}

// ── Email notifications ────────────────────────────────────────────────────
async function sendNotifications(lead, leadId, env) {
  if (!env.NOTIFY_EMAIL) return;

  const propertyValue = parseInt(lead.propertyValue || 0).toLocaleString('en-GB');
  const types         = (lead.transactionTypes || []).join(', ');

  const emailBody = `
New conveyancing lead received via ConveySelect

Lead ID: ${leadId}
Name: ${lead.firstName} ${lead.lastName}
Email: ${lead.email}
Phone: ${lead.phone}
Postcode: ${lead.postcode}
Transaction: ${types}
Property type: ${lead.propertyType}
Property value: £${propertyValue}
Timeline: ${lead.timeline}
Referred by: ${lead.agentName} (${lead.agentRef})
  `.trim();

  try {
    await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: env.NOTIFY_EMAIL }] }],
        from:    { email: 'leads@conveylink.co.uk', name: 'ConveyLink' },
        subject: `New Lead: ${lead.firstName} ${lead.lastName} — ${lead.postcode}`,
        content: [{ type: 'text/plain', value: emailBody }]
      })
    });
  } catch (e) {
    console.error('Email send failed:', e);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}
