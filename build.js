#!/usr/bin/env node
/**
 * organic-dash build
 *
 * Fetches LLM referral traffic from Looker + MQL contacts from HubSpot,
 * joins on date, and writes a static index.html for GitHub Pages.
 *
 * Env vars — required:
 *   LOOKER_CLIENT_ID, LOOKER_CLIENT_SECRET, HUBSPOT_API_TOKEN
 *
 * Env vars — optional:
 *   LOOKER_BASE_URL          default https://reporting.partnerstack.com
 *   LOOKER_LOOK_ID           saved Look ID for traffic (preferred)
 *   LOOKER_QUERY_JSON        inline query JSON (if no look id)
 *   HUBSPOT_MQL_PROPERTY     lifecycle stage property (default lifecyclestage)
 *   HUBSPOT_MQL_VALUE        MQL stage value (default marketingqualifiedlead)
 *   HUBSPOT_ATTRIBUTION_PROP property for AI/LLM attribution (default hs_analytics_source_data_1)
 *   AI_REFERRER_REGEX        case-insensitive match for AI referrers
 *   PERIOD_DAYS              default 30
 *   ZAPIER_WEBHOOK_URL       optional ping after successful build
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOOKER_BASE = (process.env.LOOKER_BASE_URL || 'https://reporting.partnerstack.com').replace(/\/$/, '');
const PERIOD_DAYS = Number(process.env.PERIOD_DAYS || 30);
const AI_REFERRER_RE = new RegExp(
  process.env.AI_REFERRER_REGEX ||
    'chatgpt|openai|perplexity|claude\\.ai|anthropic|gemini|copilot|you\\.com|phind|poe\\.com',
  'i'
);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} ${url}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function lookerLogin() {
  const clientId = requireEnv('LOOKER_CLIENT_ID');
  const clientSecret = requireEnv('LOOKER_CLIENT_SECRET');
  const body = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const data = await request(`${LOOKER_BASE}/api/4.0/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (!data || !data.access_token) throw new Error('Looker login failed: no access_token');
  return data.access_token;
}

async function lookerRunTraffic(token) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const lookId = process.env.LOOKER_LOOK_ID;

  if (lookId) {
    const qs = new URLSearchParams({
      limit: '5000',
      apply_formatting: 'false',
      apply_vis: 'false',
    });
    return request(`${LOOKER_BASE}/api/4.0/looks/${lookId}/run/json?${qs}`, { headers });
  }

  if (process.env.LOOKER_QUERY_JSON) {
    const query = JSON.parse(process.env.LOOKER_QUERY_JSON);
    return request(`${LOOKER_BASE}/api/4.0/queries/run/json`, {
      method: 'POST',
      headers,
    }, JSON.stringify(query));
  }

  const queryFile = path.join(__dirname, 'query.json');
  if (fs.existsSync(queryFile)) {
    const raw = fs
      .readFileSync(queryFile, 'utf8')
      .replace(/\{\{PERIOD_DAYS\}\}/g, String(PERIOD_DAYS));
    const query = JSON.parse(raw);
    return request(`${LOOKER_BASE}/api/4.0/queries/run/json`, {
      method: 'POST',
      headers,
    }, JSON.stringify(query));
  }

  throw new Error('Set LOOKER_LOOK_ID or LOOKER_QUERY_JSON, or commit a query.json');
}

async function hubspotSearchMqls() {
  const token = requireEnv('HUBSPOT_API_TOKEN');
  const mqlProp = process.env.HUBSPOT_MQL_PROPERTY || 'lifecyclestage';
  const mqlValue = process.env.HUBSPOT_MQL_VALUE || 'marketingqualifiedlead';
  const attrProp = process.env.HUBSPOT_ATTRIBUTION_PROP || 'hs_analytics_source_data_1';
  const since = new Date();
  since.setDate(since.getDate() - PERIOD_DAYS);

  const contacts = [];
  let after;

  do {
    const payload = {
      filterGroups: [
        {
          filters: [
            { propertyName: mqlProp, operator: 'EQ', value: mqlValue },
            { propertyName: 'createdate', operator: 'GTE', value: since.getTime().toString() },
          ],
        },
      ],
      properties: [
        'email',
        'firstname',
        'lastname',
        'company',
        'createdate',
        'hs_analytics_source',
        'hs_analytics_source_data_1',
        'hs_analytics_source_data_2',
        attrProp,
        'recent_conversion_event_name',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 100,
      ...(after ? { after } : {}),
    };

    const data = await request('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }, JSON.stringify(payload));

    if (data.results) contacts.push(...data.results);
    after = data.paging?.next?.after;
  } while (after);

  return contacts.map((c) => {
    const p = c.properties || {};
    const attribution = [
      p.hs_analytics_source,
      p.hs_analytics_source_data_1,
      p.hs_analytics_source_data_2,
      p[attrProp],
    ]
      .filter(Boolean)
      .join(' | ');
    const aiInfluenced = AI_REFERRER_RE.test(attribution);
    return {
      id: c.id,
      email: p.email || '',
      name: [p.firstname, p.lastname].filter(Boolean).join(' ') || '—',
      company: p.company || '—',
      created: p.createdate ? new Date(Number(p.createdate)).toISOString().slice(0, 10) : '—',
      attribution,
      aiInfluenced,
      conversion: p.recent_conversion_event_name || '—',
    };
  });
}

function normalizeLookerRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const keys = Object.keys(rows[0]);
  const dateKey =
    keys.find((k) => /date|week|day/i.test(k)) || keys[0];
  const sessionsKey =
    keys.find((k) => /session|visit|traffic|count|users/i.test(k) && typeof rows[0][k] === 'number') ||
    keys.find((k) => typeof rows[0][k] === 'number') ||
    keys[1];
  const referrerKey = keys.find((k) => /referrer|source|channel/i.test(k));

  const byDate = new Map();

  for (const row of rows) {
    const rawDate = row[dateKey];
    const date = String(rawDate).slice(0, 10);
    const sessions = Number(row[sessionsKey]) || 0;
    const referrer = referrerKey ? String(row[referrerKey] || '') : '';

    if (!byDate.has(date)) {
      byDate.set(date, { date, sessions: 0, aiSessions: 0, referrers: {} });
    }
    const bucket = byDate.get(date);
    bucket.sessions += sessions;
    if (AI_REFERRER_RE.test(referrer) || (!referrerKey && sessions > 0)) {
      bucket.aiSessions += referrerKey ? sessions : sessions;
      if (referrer) {
        bucket.referrers[referrer] = (bucket.referrers[referrer] || 0) + sessions;
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function topReferrers(traffic) {
  const totals = {};
  for (const day of traffic) {
    for (const [ref, n] of Object.entries(day.referrers)) {
      totals[ref] = (totals[ref] || 0) + n;
    }
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function buildHtml({ traffic, mqls, generatedAt }) {
  const totalSessions = traffic.reduce((s, d) => s + d.sessions, 0);
  const aiSessions = traffic.reduce((s, d) => s + d.aiSessions, 0);
  const aiMqls = mqls.filter((m) => m.aiInfluenced);
  const convRate = aiSessions > 0 ? ((aiMqls.length / aiSessions) * 100).toFixed(2) : '0.00';
  const referrers = topReferrers(traffic);
  const maxSessions = Math.max(...traffic.map((d) => d.aiSessions), 1);

  const chartBars = traffic
    .map(
      (d) => `
      <div class="bar-row" title="${d.date}: ${d.aiSessions} AI sessions">
        <span class="bar-label">${d.date.slice(5)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(d.aiSessions / maxSessions) * 100}%"></div></div>
        <span class="bar-val">${d.aiSessions}</span>
      </div>`
    )
    .join('');

  const mqlRows = aiMqls
    .slice(0, 25)
    .map(
      (m) => `
      <tr>
        <td>${m.created}</td>
        <td>${escapeHtml(m.company)}</td>
        <td>${escapeHtml(m.name)}</td>
        <td class="attr">${escapeHtml(m.attribution.slice(0, 80))}</td>
      </tr>`
    )
    .join('');

  const refRows = referrers
    .map(([ref, n]) => `<tr><td>${escapeHtml(ref)}</td><td>${n}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Organic Dash — LLM Referral → MQL</title>
  <style>
    :root {
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e7ecf3;
      --muted: #8b9cb3;
      --accent: #4a90d9;
      --green: #3ecf8e;
      --border: #2a3548;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    .sub { color: var(--muted); margin-bottom: 2rem; font-size: 0.95rem; }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.1rem 1.25rem;
    }
    .kpi .label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi .value { font-size: 2rem; font-weight: 700; margin-top: 0.25rem; }
    .kpi .value.green { color: var(--green); }
    .grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 1.25rem; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }
    .card h2 { font-size: 1rem; margin: 0 0 1rem; color: var(--muted); font-weight: 600; }
    .bar-row { display: grid; grid-template-columns: 52px 1fr 36px; gap: 0.5rem; align-items: center; margin-bottom: 6px; font-size: 0.8rem; }
    .bar-label { color: var(--muted); }
    .bar-track { background: #111820; border-radius: 4px; height: 18px; overflow: hidden; }
    .bar-fill { background: linear-gradient(90deg, var(--accent), #6eb5ff); height: 100%; border-radius: 4px; min-width: 2px; }
    .bar-val { text-align: right; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 0.5rem 0.4rem; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    td.attr { color: var(--muted); font-size: 0.8rem; }
    footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
    .method { font-size: 0.85rem; color: var(--muted); }
    .method code { background: #111820; padding: 0.1rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Organic Dash</h1>
    <p class="sub">LLM referral traffic → MQL conversion · PartnerStack · last ${PERIOD_DAYS} days</p>

    <div class="kpis">
      <div class="kpi"><div class="label">AI referral sessions</div><div class="value">${aiSessions.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">Total sessions (Looker)</div><div class="value">${totalSessions.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">AI-influenced MQLs</div><div class="value green">${aiMqls.length}</div></div>
      <div class="kpi"><div class="label">AI session → MQL rate</div><div class="value">${convRate}%</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>AI referral sessions by day</h2>
        ${chartBars || '<p class="method">No traffic data returned from Looker.</p>'}
      </div>
      <div class="card">
        <h2>Top AI referrers</h2>
        <table><thead><tr><th>Referrer</th><th>Sessions</th></tr></thead><tbody>${refRows || '<tr><td colspan="2">No referrer breakdown</td></tr>'}</tbody></table>
      </div>
    </div>

    <div class="card">
      <h2>Recent AI-influenced MQLs (HubSpot)</h2>
      <table>
        <thead><tr><th>Date</th><th>Company</th><th>Contact</th><th>Attribution</th></tr></thead>
        <tbody>${mqlRows || '<tr><td colspan="4">No AI-attributed MQLs in period</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card method">
      <h2>Methodology</h2>
      <p>Traffic from Looker saved Look <code>${escapeHtml(process.env.LOOKER_LOOK_ID || 'configured query')}</code>.
      MQLs from HubSpot contacts where lifecycle = <code>${escapeHtml(process.env.HUBSPOT_MQL_VALUE || 'marketingqualifiedlead')}</code>
      and attribution matches AI referrer regex. Triangulate with self-reported form data as it becomes available.</p>
    </div>

    <footer>Generated ${generatedAt} · <a href="https://github.com/charleslim-ps/organic-dash" style="color:var(--accent)">charleslim-ps/organic-dash</a></footer>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function maybePingZapier() {
  const url = process.env.ZAPIER_WEBHOOK_URL;
  if (!url) return;
  await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ event: 'organic-dash-build', at: new Date().toISOString() }));
}

async function main() {
  console.log(`Building organic-dash (${PERIOD_DAYS}-day window)...`);

  const token = await lookerLogin();
  console.log('Looker: authenticated');

  const lookerRows = await lookerRunTraffic(token);
  const traffic = normalizeLookerRows(lookerRows);
  console.log(`Looker: ${lookerRows.length} rows → ${traffic.length} days`);

  const mqls = await hubspotSearchMqls();
  console.log(`HubSpot: ${mqls.length} MQL contacts, ${mqls.filter((m) => m.aiInfluenced).length} AI-influenced`);

  const html = buildHtml({
    traffic,
    mqls,
    generatedAt: new Date().toUTCString(),
  });

  const out = path.join(__dirname, 'index.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(`Wrote ${out}`);

  await maybePingZapier();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
