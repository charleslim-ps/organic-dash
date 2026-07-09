#!/usr/bin/env node
/**
 * organic-dash render — MCP-native path.
 *
 * Reads data.json (raw rows dumped from the Claude Looker MCP) and writes:
 *   index.html    self-contained page (dark theme)
 *   artifact.html body-only fragment for a Claude Artifact (theme-aware)
 *
 * data.json shape (raw MCP field names, no transformation needed):
 * {
 *   generatedAt: ISO string,
 *   periodDays: 30,
 *   totalsBySource: [{ "google_analytics.source_medium", "google_analytics.sum_users" }],
 *   trafficDaily:   [{ "google_analytics.event_date", "google_analytics.traffic_source__source", "google_analytics.sum_users" }],
 *   mqls:           [{ "lead.mql_date_date", "lead.first_name", "lead.last_name", "lead.email",
 *                      "lead.company", "lead.lead_source", "lead.sub_source", "lead.utm_source",
 *                      "lead.utm_medium", "lead.form_name" }]
 * }
 *
 * See REFRESH.md for the exact MCP queries that produce data.json.
 */

const fs = require('fs');
const path = require('path');

// No bare "you.com" — it substring-matches peekyou.com.
const AI_RE = /chatgpt|openai|perplexity|claude\.ai|anthropic|gemini|copilot|phind|poe\.com|notebooklm/i;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadData() {
  const raw = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8');
  return JSON.parse(raw);
}

function normalizeTraffic(rows) {
  const byDate = new Map();
  const referrers = {};
  for (const row of rows) {
    const source = String(row['google_analytics.traffic_source__source'] || '');
    if (!AI_RE.test(source)) continue;
    const date = String(row['google_analytics.event_date']).slice(0, 10);
    const users = Number(row['google_analytics.sum_users']) || 0;
    if (!byDate.has(date)) byDate.set(date, { date, aiUsers: 0 });
    byDate.get(date).aiUsers += users;
    referrers[source] = (referrers[source] || 0) + users;
  }
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    referrers: Object.entries(referrers).sort((a, b) => b[1] - a[1]),
  };
}

function normalizeMqls(rows) {
  return rows.map((r) => {
    const attribution = [
      r['lead.sub_source'],
      r['lead.utm_source'],
      r['lead.utm_medium'],
      r['lead.form_name'],
    ]
      .filter(Boolean)
      .join(' | ');
    return {
      date: String(r['lead.mql_date_date'] || '').slice(0, 10),
      name: [r['lead.first_name'], r['lead.last_name']].filter(Boolean).join(' ') || '—',
      email: r['lead.email'] || '—',
      company: r['lead.company'] || '—',
      attribution,
      ai: AI_RE.test(attribution),
    };
  });
}

function buildContent(data) {
  const { daily, referrers } = normalizeTraffic(data.trafficDaily);
  const mqls = normalizeMqls(data.mqls);
  const aiMqls = mqls.filter((m) => m.ai);

  const aiUsers = daily.reduce((s, d) => s + d.aiUsers, 0);
  const totalUsers = (data.totalsBySource || []).reduce(
    (s, r) => s + (Number(r['google_analytics.sum_users']) || 0),
    0
  );
  const mqlShare = mqls.length ? ((aiMqls.length / mqls.length) * 100).toFixed(1) : '0.0';
  const convRate = aiUsers ? ((aiMqls.length / aiUsers) * 100).toFixed(2) : '0.00';
  const maxDaily = Math.max(...daily.map((d) => d.aiUsers), 1);

  const chartBars = daily
    .map(
      (d) => `
      <div class="bar-row" title="${d.date}: ${d.aiUsers} AI users">
        <span class="bar-label">${d.date.slice(5)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${((d.aiUsers / maxDaily) * 100).toFixed(1)}%"></div></div>
        <span class="bar-val">${d.aiUsers}</span>
      </div>`
    )
    .join('');

  const refRows = referrers
    .map(([ref, n]) => `<tr><td>${escapeHtml(ref)}</td><td class="num">${n.toLocaleString()}</td></tr>`)
    .join('');

  const mqlRows = aiMqls
    .map(
      (m) => `
      <tr>
        <td class="nowrap">${escapeHtml(m.date)}</td>
        <td>${escapeHtml(m.company)}</td>
        <td>${escapeHtml(m.name)}</td>
        <td class="attr">${escapeHtml(m.email)}</td>
        <td class="attr">${escapeHtml(m.attribution.slice(0, 80))}</td>
      </tr>`
    )
    .join('');

  const style = `
    .od-wrap { max-width: 1100px; margin: 0 auto; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; color: var(--od-text); }
    .od-wrap { --od-text: #1a2332; --od-muted: #5a6b82; --od-card: #ffffff; --od-border: #d7dfeb; --od-track: #eef2f8; --od-accent: #2f6fb2; --od-accent2: #5a9bd9; --od-green: #157f5f; }
    @media (prefers-color-scheme: dark) {
      .od-wrap { --od-text: #e7ecf3; --od-muted: #8b9cb3; --od-card: #1a2332; --od-border: #2a3548; --od-track: #111820; --od-accent: #4a90d9; --od-accent2: #6eb5ff; --od-green: #3ecf8e; }
    }
    :root[data-theme="dark"] .od-wrap { --od-text: #e7ecf3; --od-muted: #8b9cb3; --od-card: #1a2332; --od-border: #2a3548; --od-track: #111820; --od-accent: #4a90d9; --od-accent2: #6eb5ff; --od-green: #3ecf8e; }
    :root[data-theme="light"] .od-wrap { --od-text: #1a2332; --od-muted: #5a6b82; --od-card: #ffffff; --od-border: #d7dfeb; --od-track: #eef2f8; --od-accent: #2f6fb2; --od-accent2: #5a9bd9; --od-green: #157f5f; }
    .od-wrap h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
    .od-wrap .sub { color: var(--od-muted); margin: 0 0 1.5rem; font-size: 0.95rem; }
    .od-wrap .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .od-wrap .kpi { background: var(--od-card); border: 1px solid var(--od-border); border-radius: 12px; padding: 1rem 1.15rem; }
    .od-wrap .kpi .label { color: var(--od-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .od-wrap .kpi .value { font-size: 1.8rem; font-weight: 700; margin-top: 0.2rem; font-variant-numeric: tabular-nums; }
    .od-wrap .kpi .value.green { color: var(--od-green); }
    .od-wrap .grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 1.25rem; }
    @media (max-width: 800px) { .od-wrap .grid { grid-template-columns: 1fr; } }
    .od-wrap .card { background: var(--od-card); border: 1px solid var(--od-border); border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem; }
    .od-wrap .card h2 { font-size: 0.95rem; margin: 0 0 1rem; color: var(--od-muted); font-weight: 600; }
    .od-wrap .bar-row { display: grid; grid-template-columns: 48px 1fr 40px; gap: 0.5rem; align-items: center; margin-bottom: 5px; font-size: 0.78rem; }
    .od-wrap .bar-label { color: var(--od-muted); }
    .od-wrap .bar-track { background: var(--od-track); border-radius: 4px; height: 16px; overflow: hidden; }
    .od-wrap .bar-fill { background: linear-gradient(90deg, var(--od-accent), var(--od-accent2)); height: 100%; border-radius: 4px; min-width: 2px; }
    .od-wrap .bar-val { text-align: right; color: var(--od-muted); }
    .od-wrap .tbl-scroll { overflow-x: auto; }
    .od-wrap table { width: 100%; border-collapse: collapse; font-size: 0.84rem; font-variant-numeric: tabular-nums; }
    .od-wrap .bar-val, .od-wrap .bar-label { font-variant-numeric: tabular-nums; }
    .od-wrap th, .od-wrap td { text-align: left; padding: 0.45rem 0.4rem; border-bottom: 1px solid var(--od-border); }
    .od-wrap th { color: var(--od-muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; }
    .od-wrap td.attr { color: var(--od-muted); font-size: 0.78rem; }
    .od-wrap td.num { text-align: right; }
    .od-wrap td.nowrap { white-space: nowrap; }
    .od-wrap .method { font-size: 0.83rem; color: var(--od-muted); }
    .od-wrap footer { margin-top: 1.5rem; color: var(--od-muted); font-size: 0.78rem; }
  `;

  const body = `
  <div class="od-wrap">
    <h1>Organic Dash</h1>
    <p class="sub">LLM referral traffic → MQL conversion · PartnerStack · last ${data.periodDays} days</p>

    <div class="kpis">
      <div class="kpi"><div class="label">AI referral users</div><div class="value">${aiUsers.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">AI-attributed MQLs</div><div class="value green">${aiMqls.length}</div></div>
      <div class="kpi"><div class="label">Share of inbound MQLs</div><div class="value">${mqlShare}%</div></div>
      <div class="kpi"><div class="label">AI user → MQL rate</div><div class="value">${convRate}%</div></div>
      <div class="kpi"><div class="label">All site users</div><div class="value">${totalUsers.toLocaleString()}</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>AI referral users by day</h2>
        ${chartBars || '<p class="method">No traffic rows in data.json.</p>'}
      </div>
      <div class="card">
        <h2>AI referrers (${data.periodDays}d)</h2>
        <div class="tbl-scroll"><table><thead><tr><th>Source</th><th class="num">Users</th></tr></thead><tbody>${refRows || '<tr><td colspan="2">none</td></tr>'}</tbody></table></div>
      </div>
    </div>

    <div class="card">
      <h2>AI-attributed inbound MQLs (${aiMqls.length} of ${mqls.length} inbound MQLs)</h2>
      <div class="tbl-scroll"><table>
        <thead><tr><th>MQL date</th><th>Company</th><th>Contact</th><th>Email</th><th>Attribution</th></tr></thead>
        <tbody>${mqlRows || '<tr><td colspan="5">No AI-attributed MQLs in period</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card method">
      <h2>Methodology</h2>
      <p>Traffic: Looker <code>ops::google_analytics</code>, daily users by raw <code>traffic_source__source</code>,
      filtered to AI referrers by regex (chatgpt, openai, perplexity, claude.ai, gemini, copilot, phind, poe.com, notebooklm).
      MQLs: Looker <code>salesforce::lead</code> — <code>mql_date</code> in period, <code>lead_source = Inbound</code>,
      status excludes Holding (same definition as GTM Daily Pulse). AI attribution = regex over
      <code>sub_source</code>, <code>utm_source</code>, <code>utm_medium</code>, <code>form_name</code>.
      Data pulled via Claude MCP connectors; no direct API credentials.</p>
    </div>

    <footer>Generated ${escapeHtml(data.generatedAt)} · refreshed via Claude scheduled task</footer>
  </div>`;

  return { style, body };
}

function main() {
  const data = loadData();
  const { style, body } = buildContent(data);

  const fullPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Organic Dash — LLM Referral → MQL</title>
  <style>
    body { margin: 0; padding: 2rem 1.25rem 4rem; background: #0f1419; }
    @media (prefers-color-scheme: light) { body { background: #f4f7fb; } }
    ${style}
  </style>
</head>
<body>
${body}
</body>
</html>`;

  const fragment = `<title>Organic Dash — LLM Referral → MQL</title>
<style>${style}</style>
${body}`;

  fs.writeFileSync(path.join(__dirname, 'index.html'), fullPage, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'artifact.html'), fragment, 'utf8');
  console.log('Wrote index.html and artifact.html');
}

main();
