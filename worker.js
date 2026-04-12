/**
 * ConveySelect - Cloudflare Worker
 * Handles: lead submission, lead retrieval, status updates, admin auth
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Routes ──
      if (path === '/api/leads' && request.method === 'POST') {
        return await handleLeadSubmission(request, env);
      }

      if (path === '/api/admin/leads' && request.method === 'GET') {
        return await handleGetLeads(request, env);
      }

      if (path.startsWith('/api/admin/leads/') && request.method === 'PATCH') {
        const id = path.split('/').pop();
        return await handleUpdateLead(request, env, id);
      }

      if (path === '/api/admin/stats' && request.method === 'GET') {
        return await handleGetStats(request, env);
      }

      if (path === '/api/admin/login' && request.method === 'POST') {
        return await handleLogin(request, env);
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

  // Basic validation
  const required = ['firstName', 'lastName', 'email', 'phone', 'postcode'];
  for (const field of required) {
    if (!body[field]) {
      return jsonResponse({ error: `Missing field: ${field}` }, 400);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Save to D1
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
    body.agentRef || 'direct',
    body.agentName || 'Direct',
    JSON.stringify(body.transactionTypes || []),
    body.propertyType || '',
    body.propertyValue || 0,
    body.postcode.toUpperCase(),
    body.timeline || '',
    body.firstName,
    body.lastName,
    body.email.toLowerCase(),
    body.phone,
    now, now
  ).run();

  // Send email notifications
  await sendNotifications(body, id, env);

  return jsonResponse({ success: true, leadId: id }, 201);
}

// ── Get all leads (admin) ──────────────────────────────────────────────────
async function handleGetLeads(request, env) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const agentRef = url.searchParams.get('agent');
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT * FROM leads';
  const conditions = [];
  const params = [];

  if (status) { conditions.push('status = ?'); params.push(status); }
  if (agentRef) { conditions.push('agent_ref = ?'); params.push(agentRef); }

  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Parse JSON fields
  const leads = results.map(lead => ({
    ...lead,
    transaction_types: JSON.parse(lead.transaction_types || '[]')
  }));

  return jsonResponse({ leads, total: leads.length });
}

// ── Update lead status (admin) ────────────────────────────────────────────
async function handleUpdateLead(request, env, id) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await request.json();
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

// ── Stats (admin) ──────────────────────────────────────────────────────────
async function handleGetStats(request, env) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const [total, byStatus, byAgent, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as count FROM leads').first(),
    env.DB.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all(),
    env.DB.prepare('SELECT agent_ref, agent_name, COUNT(*) as count FROM leads GROUP BY agent_ref ORDER BY count DESC LIMIT 10').all(),
    env.DB.prepare('SELECT COUNT(*) as count FROM leads WHERE created_at > datetime("now", "-7 days")').first(),
  ]);

  return jsonResponse({
    total: total.count,
    thisWeek: recent.count,
    byStatus: byStatus.results,
    byAgent: byAgent.results,
  });
}

// ── Admin login ────────────────────────────────────────────────────────────
async function handleLogin(request, env) {
  const body = await request.json();

  if (body.password === env.ADMIN_PASSWORD) {
    return jsonResponse({ success: true, token: env.ADMIN_PASSWORD });
  }

  return jsonResponse({ error: 'Invalid password' }, 401);
}

// ── Auth check ─────────────────────────────────────────────────────────────
function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

// ── Email notifications ────────────────────────────────────────────────────
async function sendNotifications(lead, leadId, env) {
  // Uses Mailchannels (free with Cloudflare Workers) or any SMTP service
  // Replace with your preferred email provider

  if (!env.NOTIFY_EMAIL) return;

  const propertyValue = parseInt(lead.propertyValue || 0).toLocaleString('en-GB');
  const types = (lead.transactionTypes || []).join(', ');

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
        from: { email: 'leads@conveylink.co.uk', name: 'ConveyLink' },
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
