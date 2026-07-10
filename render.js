#!/usr/bin/env node
/**
 * organic-dash render — MCP-native path, interactive page.
 *
 * Reads data.json (built by make-data.js from raw Looker MCP results) and writes:
 *   index.html    self-contained interactive page
 *   artifact.html body-only fragment for the Claude Artifact (same content)
 *
 * The page embeds a compact data payload and renders client-side, with global
 * period filters (7d / 30d / 90d / All) driving every KPI, the chart, the
 * referrer table, and the MQL table. Contact-level rows are embedded for all
 * AI-attributed MQLs plus non-AI MQLs in the most recent 90 days; older non-AI
 * MQLs are represented in daily/monthly counts only, to keep the page small.
 */

const fs = require('fs');
const path = require('path');

// No bare "you.com" — it substring-matches peekyou.com. meta.ai included
// because HubSpot's AI Referrals bucket sees it in this portal.
const AI_RE = /chatgpt|openai|perplexity|claude\.ai|anthropic|gemini|copilot|phind|poe\.com|notebooklm|meta\.ai/i;
const NON_AI_DETAIL_DAYS = 90;

function loadData() {
  const raw = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8');
  return JSON.parse(raw);
}

function mqlAttribution(r) {
  return [r['lead.sub_source'], r['lead.utm_source'], r['lead.utm_medium'], r['lead.form_name']]
    .filter(Boolean)
    .join(' | ');
}

function buildPayload(data) {
  // Traffic: [date, source, users], AI-only (defensive re-filter by regex).
  const ai = data.trafficDailyAi
    .filter((r) => AI_RE.test(String(r['google_analytics.traffic_source__source'] || '')))
    .map((r) => [
      String(r['google_analytics.event_date']).slice(0, 10),
      String(r['google_analytics.traffic_source__source']),
      Number(r['google_analytics.sum_users']) || 0,
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const tot = data.trafficDailyTotal
    .map((r) => [String(r['google_analytics.event_date']).slice(0, 10), Number(r['google_analytics.sum_users']) || 0])
    .sort((a, b) => a[0].localeCompare(b[0]));

  // MQL contact rows: classify, then embed AI rows (always) + non-AI rows
  // within the last NON_AI_DETAIL_DAYS of coverage.
  const contacts = data.mqls.map((r) => {
    const attribution = mqlAttribution(r);
    return {
      d: String(r['lead.mql_date_date'] || '').slice(0, 10),
      n: [r['lead.first_name'], r['lead.last_name']].filter(Boolean).join(' ') || '—',
      e: r['lead.email'] || '—',
      c: r['lead.company'] || '—',
      a: attribution,
      ai: AI_RE.test(attribution) ? 1 : 0,
    };
  });

  const backfill = (data.historicalAiBackfill || []).map((r) => ({
    d: String(r['lead.mql_date_date']).slice(0, 10),
    n: [r['lead.first_name'], r['lead.last_name']].filter(Boolean).join(' ') || '—',
    e: r['lead.email'] || '—',
    c: r['lead.company'] || '—',
    a: mqlAttribution(r),
    ai: 1,
  }));

  const dates = contacts.map((m) => m.d).sort();
  const contactMin = dates[0] || '';
  const maxDate = dates[dates.length - 1] || '';
  const nonAiMin = addDays(maxDate, -NON_AI_DETAIL_DAYS);

  const seen = new Set();
  const rows = [];
  for (const m of [...contacts, ...backfill]) {
    const key = `${m.d}|${m.e}|${m.n}`;
    if (m.ai) {
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(m);
    } else if (m.d >= nonAiMin) {
      rows.push(m);
    }
  }
  rows.sort((a, b) => b.d.localeCompare(a.d));

  // Daily inbound counts from full contact coverage (for 7/30/90d denominators).
  const mqlDaily = {};
  for (const m of contacts) mqlDaily[m.d] = (mqlDaily[m.d] || 0) + 1;

  // Full-window inbound denominator: exact contact count when the contact
  // pull covers the whole trimmed window, else the monthly-counts sum
  // (approximate at the boundary month).
  const contactsCoverWindow = contactMin && data.trimCutoff && contactMin <= addDays(data.trimCutoff, 1);
  const allInbound = contactsCoverWindow
    ? contacts.length
    : data.mqlMonthly.reduce((s, r) => s + (Number(r['lead.count']) || 0), 0);

  return {
    generatedAt: data.generatedAt,
    ai,
    tot,
    rows: rows.map((m) => [m.d, m.n, m.e, m.c, m.a, m.ai]),
    mqlDaily: Object.entries(mqlDaily).sort((a, b) => a[0].localeCompare(b[0])),
    allInbound,
    contactMin,
    nonAiMin,
    // Cloudflare AI crawler requests: [date, crawler, operator, category, count]
    crawl: data.crawlDaily || [],
    crawlStart: data.crawlStart || '',
    crawlEnd: data.crawlEnd || '',
  };
}

function addDays(iso, delta) {
  if (!iso) return '';
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

// Source-of-truth report links, shown under tile headers so the numbers can be
// eyeballed against the upstream systems. HubSpot portal 7012252 has the
// built-in "AI Referrals" traffic bucket; MQLs have no HubSpot equivalent
// (SFDC via Looker is the MQL source of truth), so those tiles link to the
// matching Looker explore instead.
const HS_TRAFFIC_URL = 'https://app.hubspot.com/analytics/7012252/traffic/sources';
const LOOKER_MQL_URL =
  'https://reporting.partnerstack.com/explore/salesforce/lead?fields=lead.mql_date_month,lead.count&amp;f[lead.mql_date_date]=13+months&amp;f[lead.status]=-Holding&amp;f[lead.lead_source]=Inbound&amp;sorts=lead.mql_date_month+desc&amp;limit=100';
const CF_CRAWL_URL = 'https://dash.cloudflare.com/e01cc42974eee44a8e992b8e7df25a19/partnerstack.com/ai-crawl-control';

// Design system lifted from https://ad-vibe-coding.github.io/organic-dash/ —
// stone neutrals, periwinkle accent, Inter, rounded-2xl bordered cards,
// uppercase eyebrow labels, mono tabular numerals. Deliberately single-theme
// dark (#0f0f0e) so the page reads the same on any host background.
// Mobile-first: base styles are the small-screen layout; min-width queries
// scale up.
const STYLE = `
    body { background: #0f0f0e !important; }
    .od-page { background: #0f0f0e; padding: 40px; margin: 0 auto; }
    .od-wrap { position: relative; max-width: 1200px; margin: 0 auto; font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 0.875rem; line-height: 1.5; color: var(--od-text); color-scheme: dark; }
    .od-wrap { --od-text: #f5f4f0; --od-muted: #a09f9a; --od-faint: #6b6a65; --od-surface: #1a1a19; --od-surface2: #232321; --od-border: #2a2a28; --od-accent: #7b82e8; --od-green: #34d399; }
    .od-wrap .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .od-wrap .head { display: flex; flex-direction: column; gap: 1.25rem; align-items: flex-start; margin-bottom: 1.5rem; }
    .od-wrap .slug { font-size: 16px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; color: #ffffff; margin-bottom: 0.75rem; }
    .od-wrap h1 { font-size: 3rem; font-weight: 600; letter-spacing: -0.07em; line-height: 0.92; margin: 0; text-wrap: balance; }
    @media (min-width: 640px) { .od-wrap h1 { font-size: 72px; } }
    .od-wrap .sub { color: var(--od-muted); margin: 0.5rem 0 0; font-size: 0.875rem; }
    .od-wrap .filters { display: flex; flex-wrap: wrap; gap: 8px; }
    .od-wrap .filters button { font: inherit; font-size: 0.75rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.5rem 1rem; border-radius: 999px; border: 1px solid var(--od-border); background: var(--od-surface); color: var(--od-muted); cursor: pointer; transition: background-color 0.15s, color 0.15s; }
    .od-wrap .filters button:hover { background: var(--od-surface2); color: var(--od-text); }
    .od-wrap .filters button:focus-visible { outline: 2px solid var(--od-accent); outline-offset: 2px; }
    .od-wrap .filters button[aria-pressed="true"] { background: var(--od-accent); border-color: var(--od-accent); color: #fff; }
    .od-wrap .kpis { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin-bottom: 1.5rem; }
    @media (min-width: 480px) { .od-wrap .kpis { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1024px) { .od-wrap .kpis { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); } }
    .od-wrap .kpi { background: var(--od-surface); border: 1px solid var(--od-border); border-radius: 1rem; padding: 1.25rem 1.5rem; }
    .od-wrap .kpi .label { color: var(--od-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
    .od-wrap .vlink { display: block; font-size: 0.65rem; color: var(--od-faint); text-decoration: none; margin-top: 0.25rem; }
    .od-wrap .vlink:hover { color: var(--od-accent); text-decoration: underline; }
    .od-wrap .card > .vlink { margin: -0.9rem 0 1.25rem; }
    .od-wrap .kpi .value { font-size: 2.25rem; font-weight: 600; letter-spacing: -0.025em; margin-top: 0.6rem; font-variant-numeric: tabular-nums; }
    .od-wrap .kpi .value.green { color: var(--od-green); }
    .od-wrap .card { background: var(--od-surface); border: 1px solid var(--od-border); border-radius: 1rem; padding: 1.5rem; margin-bottom: 1.5rem; }
    .od-wrap .card h2 { font-size: 0.75rem; margin: 0 0 1.25rem; color: var(--od-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; }
    .od-wrap .grid2 { display: grid; grid-template-columns: 1fr; gap: 1.5rem; }
    @media (min-width: 800px) { .od-wrap .grid2 { grid-template-columns: 1fr 1fr; } }
    .od-wrap .chart { position: relative; height: 220px; }
    @media (min-width: 640px) { .od-wrap .chart { height: 260px; } }
    .od-wrap .gridline { position: absolute; left: 0; right: 0; border-top: 1px solid var(--od-border); }
    .od-wrap .gridline span { position: absolute; right: 0; top: -1.1rem; font-size: 0.7rem; color: var(--od-faint); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
    .od-wrap .bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
    .od-wrap .bars.dense { gap: 1px; }
    .od-wrap .bar { position: relative; flex: 1 1 0; min-width: 1px; height: 100%; display: flex; align-items: flex-end; cursor: default; }
    .od-wrap .bar > i { display: block; width: 100%; background: var(--od-accent); border-radius: 3px 3px 0 0; }
    .od-wrap .bar:hover > i { background: color-mix(in srgb, var(--od-accent) 70%, var(--od-text)); }
    .od-wrap .bar > u { position: absolute; bottom: 0; left: 20%; width: 60%; display: block; background: var(--od-green); border-radius: 2px 2px 0 0; pointer-events: none; }
    .od-wrap .xlabels { display: flex; justify-content: space-between; margin-top: 8px; font-size: 0.7rem; color: var(--od-faint); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
    .od-wrap .tip { position: absolute; pointer-events: none; background: var(--od-surface); border: 1px solid var(--od-border); border-radius: 0.5rem; padding: 0.4rem 0.65rem; font-size: 0.75rem; box-shadow: 0 8px 24px rgba(0,0,0,0.18); white-space: nowrap; z-index: 5; display: none; }
    .od-wrap .tip b { font-variant-numeric: tabular-nums; }
    .od-wrap .tbl-scroll { overflow-x: auto; }
    .od-wrap table { width: 100%; border-collapse: collapse; font-size: 0.875rem; font-variant-numeric: tabular-nums; }
    .od-wrap th, .od-wrap td { text-align: left; padding: 0.7rem 0.5rem; border-bottom: 1px solid var(--od-border); }
    .od-wrap tbody tr { transition: background-color 0.15s; }
    .od-wrap tbody tr:hover { background: var(--od-surface2); }
    .od-wrap tbody tr:last-child td { border-bottom: 0; }
    .od-wrap th { color: var(--od-muted); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
    .od-wrap td.attr { color: var(--od-muted); font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .od-wrap td.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .od-wrap td.nowrap { white-space: nowrap; }
    .od-wrap .chip { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--od-accent) 30%, transparent); background: color-mix(in srgb, var(--od-accent) 12%, transparent); color: var(--od-accent); font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
    .od-wrap .loadall { font: inherit; font-size: 0.75rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 1rem; padding: 0.5rem 1rem; border-radius: 999px; border: 1px solid var(--od-border); background: var(--od-surface); color: var(--od-text); cursor: pointer; transition: background-color 0.15s; }
    .od-wrap .loadall:hover { background: color-mix(in srgb, var(--od-accent) 20%, var(--od-surface2)); }
    .od-wrap .loadall:focus-visible { outline: 2px solid var(--od-accent); outline-offset: 2px; }
    .od-wrap .note { font-size: 0.75rem; color: var(--od-faint); margin-top: 0.6rem; }
    .od-wrap .legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; margin-bottom: 1rem; font-size: 0.75rem; color: var(--od-muted); }
    .od-wrap .legend .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 0.35rem; vertical-align: baseline; }
    .od-wrap .bar.stacked { flex-direction: column-reverse; }
    .od-wrap .bar.stacked > b { display: block; width: 100%; }
    .od-wrap .bar.stacked > b:last-child { border-radius: 3px 3px 0 0; }
    .od-wrap .funnel { display: flex; flex-direction: column; gap: 0; }
    .od-wrap .funnel .stage { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: 0.85rem 0; }
    .od-wrap .funnel .stage .name { color: var(--od-muted); font-size: 0.8rem; }
    .od-wrap .funnel .stage .val { font-size: 1.6rem; font-weight: 600; letter-spacing: -0.025em; font-variant-numeric: tabular-nums; }
    .od-wrap .funnel .conv { font-size: 0.75rem; color: var(--od-accent); padding: 0.15rem 0 0.15rem 0.9rem; border-left: 2px solid var(--od-border); margin-left: 0.25rem; font-variant-numeric: tabular-nums; }
    .od-wrap .method { font-size: 0.8rem; color: var(--od-muted); }
    .od-wrap .method code { background: var(--od-surface2); border-radius: 0.25rem; padding: 0.05rem 0.3rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.75rem; }
    .od-wrap footer { margin-top: 2rem; color: var(--od-faint); font-size: 0.75rem; }
    @media (prefers-reduced-motion: reduce) { .od-wrap * { transition: none !important; } }
`;

const MARKUP = `
  <div class="od-page">
  <div class="od-wrap">
    <div class="head">
      <div>
        <div class="slug">Organic Dash</div>
        <h1>LLM referral traffic → MQL conversion</h1>
        <p class="sub">PartnerStack · Last updated <span id="od-updated"></span> · <span id="od-period-label"></span></p>
      </div>
      <div class="filters" role="group" aria-label="Time period">
        <button data-p="7">7d</button>
        <button data-p="30">30d</button>
        <button data-p="90">90d</button>
        <button data-p="all">12m</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="label">AI referral users</div><a class="vlink" href="${HS_TRAFFIC_URL}" target="_blank" rel="noopener">HS traffic report ↗</a><div class="value" id="k-ai"></div></div>
      <div class="kpi"><div class="label">AI-attributed MQLs</div><a class="vlink" href="${LOOKER_MQL_URL}" target="_blank" rel="noopener">Looker report ↗</a><div class="value green" id="k-mql"></div></div>
      <div class="kpi"><div class="label">Share of inbound MQLs</div><a class="vlink" href="${LOOKER_MQL_URL}" target="_blank" rel="noopener">Looker report ↗</a><div class="value" id="k-share"></div></div>
      <div class="kpi"><div class="label">AI user → MQL rate</div><a class="vlink" href="${LOOKER_MQL_URL}" target="_blank" rel="noopener">Looker report ↗</a><div class="value" id="k-conv"></div></div>
      <div class="kpi"><div class="label">All site users</div><a class="vlink" href="${HS_TRAFFIC_URL}" target="_blank" rel="noopener">HS traffic report ↗</a><div class="value" id="k-tot"></div></div>
    </div>

    <div class="card">
      <h2 id="chart-title">AI referral users by day</h2>
      <div class="legend"><span><span class="dot" style="background:var(--od-accent)"></span>AI referral users</span><span><span class="dot" style="background:var(--od-green)"></span>AI-attributed MQLs (own scale)</span></div>
      <div class="chart" id="chart"></div>
      <div class="xlabels" id="xlabels"></div>
    </div>

    <div id="crawl-section" style="display:none">
      <div class="card">
        <h2 id="crawl-title">AI Crawl Control — crawler requests by day</h2>
        <a class="vlink" href="${CF_CRAWL_URL}" target="_blank" rel="noopener">Cloudflare AI Crawl Control ↗</a>
        <div class="legend" id="crawl-legend"></div>
        <div class="chart" id="crawl-chart"></div>
        <div class="xlabels" id="crawl-xlabels"></div>
        <div class="note" id="crawl-note"></div>
      </div>

      <div class="grid2">
        <div class="card">
          <h2 id="crawler-tbl-title">AI crawlers</h2>
          <div class="tbl-scroll"><table>
            <thead><tr><th>Crawler</th><th>Operator</th><th>Type</th><th class="num">Requests</th><th class="num">Share</th></tr></thead>
            <tbody id="crawler-body"></tbody>
          </table></div>
        </div>
        <div class="card">
          <h2 id="funnel-title">Crawl → visit → MQL</h2>
          <div class="funnel" id="funnel"></div>
          <div class="note" id="funnel-note"></div>
        </div>
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <h2 id="ref-title">AI referrers</h2>
        <div class="tbl-scroll"><table><thead><tr><th>Source</th><th class="num">Users</th></tr></thead><tbody id="ref-body"></tbody></table></div>
      </div>
      <div class="card method">
        <h2>Methodology</h2>
        <p>Traffic: Looker <code>ops::google_analytics</code>, daily users by raw <code>traffic_source__source</code>,
        AI referrers matched by regex (chatgpt, openai, perplexity, claude.ai, gemini, copilot, phind, poe.com, notebooklm).
        MQLs: Looker <code>salesforce::lead</code> — <code>mql_date</code> in period, <code>lead_source = Inbound</code>,
        status excludes Holding (same definition as GTM Daily Pulse). AI attribution = regex over
        <code>sub_source</code>, <code>utm_source</code>, <code>utm_medium</code>, <code>form_name</code>.
        Crawl: Cloudflare GraphQL <code>httpRequestsAdaptiveGroups</code>, hostname <code>partnerstack.com</code>
        only (marketing site; excludes js/dash/api and partner-page subdomains), verified bot categories
        <code>AI Crawler / AI Assistant / AI Search</code> only (search-engine crawlers excluded;
        ~90-day edge retention). Cloudflare's "AI referrals" metric is deliberately NOT used for the
        referral funnel above — it counts Google Search among referrers; visits stay GA4-only.
        Data pulled via Claude MCP connectors; no direct API credentials.</p>
      </div>
    </div>

    <div class="card">
      <h2 id="mql-title">AI-attributed inbound MQLs</h2>
      <div class="tbl-scroll"><table>
        <thead><tr><th>MQL date</th><th>Company</th><th>Contact</th><th>Email</th><th>Attribution</th></tr></thead>
        <tbody id="mql-body"></tbody>
      </table></div>
      <button class="loadall" id="loadall"></button>
      <div class="note" id="mql-note"></div>
    </div>

    <footer id="od-footer"></footer>
    <div class="tip" id="tip"></div>
  </div>
  </div>
`;

// Client-side app. Kept as a plain string so render.js stays dependency-free.
const SCRIPT = `
(function () {
  var D = window.__OD_DATA__;
  var state = { period: '30', showAll: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function addDays(iso, delta) {
    var t = new Date(iso + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + delta);
    return t.toISOString().slice(0, 10);
  }
  function maxDate() {
    var m = '';
    if (D.ai.length) m = D.ai[D.ai.length - 1][0];
    if (D.tot.length && D.tot[D.tot.length - 1][0] > m) m = D.tot[D.tot.length - 1][0];
    if (D.mqlDaily.length && D.mqlDaily[D.mqlDaily.length - 1][0] > m) m = D.mqlDaily[D.mqlDaily.length - 1][0];
    return m;
  }
  function cutoff() {
    if (state.period === 'all') return '';
    return addDays(maxDate(), -Number(state.period));
  }

  function weekStart(iso) {
    var t = new Date(iso + 'T00:00:00Z');
    var dow = (t.getUTCDay() + 6) % 7; // Monday = 0
    t.setUTCDate(t.getUTCDate() - dow);
    return t.toISOString().slice(0, 10);
  }

  function render() {
    var co = cutoff();
    var inWin = function (d) { return !co || d >= co; };

    // --- traffic aggregates
    var aiByDay = {}, refTotals = {}, aiUsers = 0;
    D.ai.forEach(function (r) {
      if (!inWin(r[0])) return;
      aiByDay[r[0]] = (aiByDay[r[0]] || 0) + r[2];
      refTotals[r[1]] = (refTotals[r[1]] || 0) + r[2];
      aiUsers += r[2];
    });
    var totUsers = 0;
    D.tot.forEach(function (r) { if (inWin(r[0])) totUsers += r[1]; });

    // --- MQL aggregates
    var aiMqls = D.rows.filter(function (r) { return r[5] === 1 && inWin(r[0]); });
    var inbound;
    if (state.period === 'all') {
      inbound = D.allInbound;
    } else {
      inbound = 0;
      D.mqlDaily.forEach(function (r) { if (inWin(r[0])) inbound += r[1]; });
    }

    // --- KPIs
    document.getElementById('k-ai').textContent = fmt(aiUsers);
    document.getElementById('k-mql').textContent = fmt(aiMqls.length);
    document.getElementById('k-share').textContent = inbound ? ((aiMqls.length / inbound) * 100).toFixed(1) + '%' : '—';
    document.getElementById('k-conv').textContent = aiUsers ? ((aiMqls.length / aiUsers) * 100).toFixed(2) + '%' : '—';
    document.getElementById('k-tot').textContent = fmt(totUsers);
    document.getElementById('od-updated').textContent = new Date(D.generatedAt)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('od-period-label').textContent =
      state.period === 'all' ? 'last 12 months' : 'last ' + state.period + ' days';

    // --- chart (daily; weekly when the window is long)
    var days = Object.keys(aiByDay).sort();
    var weekly = days.length > 120;
    var buckets = {};
    days.forEach(function (d) {
      var k = weekly ? weekStart(d) : d;
      buckets[k] = (buckets[k] || 0) + aiByDay[d];
    });
    var keys = Object.keys(buckets).sort();
    document.getElementById('chart-title').textContent = 'AI referral users + MQLs by ' + (weekly ? 'week' : 'day');
    var max = 1;
    keys.forEach(function (k) { if (buckets[k] > max) max = buckets[k]; });

    // MQL overlay: same buckets, own scale (daily counts are tiny next to
    // users), capped at 30% of chart height.
    var mqlBuckets = {};
    aiMqls.forEach(function (r) {
      var k = weekly ? weekStart(r[0]) : r[0];
      mqlBuckets[k] = (mqlBuckets[k] || 0) + 1;
    });
    var maxM = 0;
    keys.forEach(function (k) { if ((mqlBuckets[k] || 0) > maxM) maxM = mqlBuckets[k]; });

    var chart = document.getElementById('chart');
    var html = '';
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      html += '<div class="gridline" style="bottom:' + f * 100 + '%"><span>' + fmt(Math.round(max * f)) + '</span></div>';
    });
    html += '<div class="bars' + (keys.length > 90 ? ' dense' : '') + '">';
    keys.forEach(function (k, i) {
      var v = buckets[k];
      var h = Math.max((v / max) * 100, v > 0 ? 1 : 0);
      var m = mqlBuckets[k] || 0;
      var mh = maxM ? (m / maxM) * 30 : 0;
      html += '<div class="bar" data-i="' + i + '"><i style="height:' + h.toFixed(2) + '%"></i>' +
        (m ? '<u style="height:' + mh.toFixed(2) + '%"></u>' : '') + '</div>';
    });
    html += '</div>';
    chart.innerHTML = html;
    chart.__keys = keys;
    chart.__buckets = buckets;
    chart.__mql = mqlBuckets;
    chart.__weekly = weekly;

    var xl = document.getElementById('xlabels');
    var ticks = [];
    var n = Math.min(8, keys.length);
    for (var i = 0; i < n; i++) ticks.push(keys[Math.round((i * (keys.length - 1)) / Math.max(n - 1, 1))]);
    xl.innerHTML = ticks.map(function (t) { return '<span>' + t.slice(2) + '</span>'; }).join('');

    // --- referrers
    var refs = Object.keys(refTotals).map(function (k) { return [k, refTotals[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    document.getElementById('ref-title').textContent = 'AI referrers (' + (state.period === 'all' ? '12m' : 'last ' + state.period + 'd') + ')';
    document.getElementById('ref-body').innerHTML = refs.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td class="num">' + fmt(r[1]) + '</td></tr>';
    }).join('') || '<tr><td colspan="2">none</td></tr>';

    // --- MQL table
    var rows = state.showAll
      ? D.rows.filter(function (r) { return inWin(r[0]); })
      : aiMqls;
    document.getElementById('mql-title').textContent =
      (state.showAll ? 'Inbound MQLs' : 'AI-attributed inbound MQLs') + ' — ' + fmt(aiMqls.length) + ' AI of ' + fmt(inbound) + ' inbound';
    document.getElementById('mql-body').innerHTML = rows.map(function (r) {
      return '<tr><td class="nowrap">' + r[0] + (r[5] === 1 && state.showAll ? ' <span class="chip">AI</span>' : '') + '</td><td>' + esc(r[3]) +
        '</td><td>' + esc(r[1]) + '</td><td class="attr">' + esc(r[2]) + '</td><td class="attr">' + esc(String(r[4]).slice(0, 80)) + '</td></tr>';
    }).join('') || '<tr><td colspan="5">No MQLs in period</td></tr>';

    var btn = document.getElementById('loadall');
    btn.textContent = state.showAll ? 'Show AI-attributed only' : 'Load all ' + fmt(inbound) + ' inbound MQLs';
    var note = '';
    if (state.showAll && (!co || co < D.nonAiMin)) note = 'Non-AI contact detail covers ' + D.nonAiMin + ' onward; AI-attributed detail is complete back to ' + D.contactMin + '. Earlier non-AI MQLs are included in counts only.';
    document.getElementById('mql-note').textContent = note;

    document.getElementById('od-footer').textContent = 'Generated ' + D.generatedAt + ' \\u00b7 refreshed daily via Claude scheduled task';

    renderCrawl(co, aiMqls);
  }

  var OP_COLORS = ['#7b82e8', '#34d399', '#f59e0b', '#f472b6', '#38bdf8', '#c4b5fd', '#6b6a65'];

  function renderCrawl(co, aiMqls) {
    var C = D.crawl || [];
    var section = document.getElementById('crawl-section');
    if (!C.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    // The crawl window is the selected period clamped to Cloudflare coverage.
    var start = co && co > D.crawlStart ? co : D.crawlStart;
    var clamped = !co || co < D.crawlStart;
    var rows = C.filter(function (r) { return r[0] >= start; });

    // --- aggregates: per-operator totals, per-crawler totals, per-day stacks
    var opTotals = {}, crawlerAgg = {}, total = 0;
    rows.forEach(function (r) {
      opTotals[r[2]] = (opTotals[r[2]] || 0) + r[4];
      var key = r[1];
      if (!crawlerAgg[key]) crawlerAgg[key] = { op: r[2], cat: r[3], n: 0 };
      crawlerAgg[key].n += r[4];
      total += r[4];
    });
    var topOps = Object.keys(opTotals).sort(function (a, b) { return opTotals[b] - opTotals[a]; });
    var shown = topOps.slice(0, OP_COLORS.length - 1);
    var opColor = {};
    shown.forEach(function (o, i) { opColor[o] = OP_COLORS[i]; });
    var OTHER = 'Other';
    var hasOther = topOps.length > shown.length;

    // --- stacked daily chart
    var byDay = {};
    rows.forEach(function (r) {
      var day = byDay[r[0]] || (byDay[r[0]] = { total: 0, ops: {} });
      var op = opColor[r[2]] ? r[2] : OTHER;
      day.ops[op] = (day.ops[op] || 0) + r[4];
      day.total += r[4];
    });
    var keys = Object.keys(byDay).sort();
    var max = 1;
    keys.forEach(function (k) { if (byDay[k].total > max) max = byDay[k].total; });
    var stack = shown.slice();
    if (hasOther) stack.push(OTHER);
    var chart = document.getElementById('crawl-chart');
    var html = '';
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      html += '<div class="gridline" style="bottom:' + f * 100 + '%"><span>' + fmt(Math.round(max * f)) + '</span></div>';
    });
    html += '<div class="bars' + (keys.length > 90 ? ' dense' : '') + '">';
    keys.forEach(function (k, i) {
      var segs = '';
      stack.forEach(function (op) {
        var v = byDay[k].ops[op] || 0;
        if (!v) return;
        var h = (v / max) * 100;
        segs += '<b style="height:' + h.toFixed(2) + '%;background:' + (opColor[op] || OP_COLORS[OP_COLORS.length - 1]) + '"></b>';
      });
      html += '<div class="bar stacked" data-i="' + i + '">' + segs + '</div>';
    });
    html += '</div>';
    chart.innerHTML = html;
    chart.__keys = keys;
    chart.__byDay = byDay;
    chart.__stack = stack;

    var xl = document.getElementById('crawl-xlabels');
    var ticks = [];
    var n = Math.min(8, keys.length);
    for (var i = 0; i < n; i++) ticks.push(keys[Math.round((i * (keys.length - 1)) / Math.max(n - 1, 1))]);
    xl.innerHTML = ticks.map(function (t) { return '<span>' + t.slice(2) + '</span>'; }).join('');

    document.getElementById('crawl-title').textContent =
      'AI Crawl Control — ' + fmt(total) + ' crawler requests (' + (clamped ? 'since ' + start : 'last ' + state.period + 'd') + ')';
    document.getElementById('crawl-legend').innerHTML = stack.map(function (op) {
      var col = opColor[op] || OP_COLORS[OP_COLORS.length - 1];
      return '<span><span class="dot" style="background:' + col + '"></span>' + esc(op) + '</span>';
    }).join('');
    document.getElementById('crawl-note').textContent = clamped
      ? 'Cloudflare edge retention is ~90 days: crawl data covers ' + D.crawlStart + ' \\u2192 ' + D.crawlEnd + '; longer windows are clamped.'
      : 'Source: Cloudflare, host partnerstack.com only (marketing site \\u2014 no product/asset subdomains) \\u00b7 verified AI bots (AI Crawler / AI Assistant / AI Search).';

    // --- crawler table (top 14 + rollup)
    var list = Object.keys(crawlerAgg).map(function (k) { return [k, crawlerAgg[k]]; }).sort(function (a, b) { return b[1].n - a[1].n; });
    var top = list.slice(0, 14);
    var restN = list.slice(14).reduce(function (s, e) { return s + e[1].n; }, 0);
    document.getElementById('crawler-tbl-title').textContent = 'AI crawlers (' + list.length + ')';
    document.getElementById('crawler-body').innerHTML = top.map(function (e) {
      return '<tr><td>' + esc(e[0]) + '</td><td>' + esc(e[1].op) + '</td><td class="attr">' + esc(e[1].cat.replace('AI ', '')) +
        '</td><td class="num">' + fmt(e[1].n) + '</td><td class="num">' + (total ? ((e[1].n / total) * 100).toFixed(1) : '0.0') + '%</td></tr>';
    }).join('') + (restN ? '<tr><td>' + (list.length - top.length) + ' more\\u2026</td><td></td><td></td><td class="num">' + fmt(restN) +
      '</td><td class="num">' + ((restN / total) * 100).toFixed(1) + '%</td></tr>' : '');

    // --- crawl -> visit -> MQL funnel, all stages over the same clamped window
    var aiUsersF = 0;
    D.ai.forEach(function (r) { if (r[0] >= start && r[0] <= D.crawlEnd) aiUsersF += r[2]; });
    var aiMqlsF = D.rows.filter(function (r) { return r[5] === 1 && r[0] >= start && r[0] <= D.crawlEnd; }).length;
    var per1k = total ? (aiUsersF / total) * 1000 : 0;
    var mqlRate = aiUsersF ? (aiMqlsF / aiUsersF) * 100 : 0;
    document.getElementById('funnel').innerHTML =
      '<div class="stage"><span class="name">AI crawler requests (Cloudflare edge)</span><span class="val">' + fmt(total) + '</span></div>' +
      '<div class="conv">\\u2193 ' + per1k.toFixed(1) + ' AI referral users per 1k crawler requests</div>' +
      '<div class="stage"><span class="name">AI referral users (GA4)</span><span class="val">' + fmt(aiUsersF) + '</span></div>' +
      '<div class="conv">\\u2193 ' + mqlRate.toFixed(2) + '% of AI referral users become MQLs</div>' +
      '<div class="stage"><span class="name">AI-attributed MQLs (Salesforce)</span><span class="val green" style="color:var(--od-green)">' + fmt(aiMqlsF) + '</span></div>';
    document.getElementById('funnel-note').textContent =
      'Same ' + (clamped ? D.crawlStart + ' \\u2192 ' + D.crawlEnd : 'last-' + state.period + 'd') +
      ' window for all three stages. Stages are different units (bot requests \\u2192 human users \\u2192 leads); the ratios are directional, not a strict same-cohort funnel.';
  }

  // chart tooltip
  var tip = document.getElementById('tip');
  var chartEl = document.getElementById('chart');
  chartEl.addEventListener('mousemove', function (ev) {
    var bar = ev.target.closest ? ev.target.closest('.bar') : null;
    if (!bar) { tip.style.display = 'none'; return; }
    var keys = chartEl.__keys, buckets = chartEl.__buckets;
    var k = keys[Number(bar.getAttribute('data-i'))];
    var m = (chartEl.__mql || {})[k] || 0;
    tip.innerHTML = (chartEl.__weekly ? 'wk of ' : '') + k + ': <b>' + Number(buckets[k]).toLocaleString('en-US') + '</b> users' +
      (m ? ' \\u00b7 <b style="color:var(--od-green)">' + m + '</b> MQL' + (m > 1 ? 's' : '') : '');
    tip.style.display = 'block';
    var wrap = chartEl.closest('.od-wrap');
    var wr = wrap.getBoundingClientRect();
    var x = ev.clientX - wr.left + 14, y = ev.clientY - wr.top - 34;
    if (x + tip.offsetWidth > wrap.clientWidth) x -= tip.offsetWidth + 24;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  chartEl.addEventListener('mouseleave', function () { tip.style.display = 'none'; });

  var crawlEl = document.getElementById('crawl-chart');
  crawlEl.addEventListener('mousemove', function (ev) {
    var bar = ev.target.closest ? ev.target.closest('.bar') : null;
    if (!bar) { tip.style.display = 'none'; return; }
    var k = crawlEl.__keys[Number(bar.getAttribute('data-i'))];
    var day = crawlEl.__byDay[k];
    var lines = crawlEl.__stack
      .filter(function (op) { return day.ops[op]; })
      .map(function (op) { return esc(op) + ': <b>' + fmt(day.ops[op]) + '</b>'; });
    tip.innerHTML = k + ' \\u00b7 <b>' + fmt(day.total) + '</b> requests<br>' + lines.join('<br>');
    tip.style.display = 'block';
    var wrap = crawlEl.closest('.od-wrap');
    var wr = wrap.getBoundingClientRect();
    var x = ev.clientX - wr.left + 14, y = ev.clientY - wr.top - 34;
    if (x + tip.offsetWidth > wrap.clientWidth) x -= tip.offsetWidth + 24;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  crawlEl.addEventListener('mouseleave', function () { tip.style.display = 'none'; });

  var btns = document.querySelectorAll('.filters button');
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      state.period = b.getAttribute('data-p');
      btns.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      render();
    });
  });
  btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-p') === state.period)); });

  document.getElementById('loadall').addEventListener('click', function () {
    state.showAll = !state.showAll;
    render();
  });

  render();
})();
`;

function main() {
  const data = loadData();
  const payload = buildPayload(data);
  const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');

  const inner = `${MARKUP}
<script>window.__OD_DATA__ = ${payloadJson};</script>
<script>${SCRIPT}</script>`;

  const fullPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Organic Dash — LLM Referral → MQL</title>
  <style>
    body { margin: 0; }
    ${STYLE}
  </style>
</head>
<body>
${inner}
</body>
</html>`;

  const fragment = `<title>Organic Dash — LLM Referral → MQL</title>
<style>${STYLE}</style>
${inner}`;

  fs.writeFileSync(path.join(__dirname, 'index.html'), fullPage, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'artifact.html'), fragment, 'utf8');
  console.log(
    `Wrote index.html + artifact.html — ${payload.ai.length} AI traffic rows, ${payload.rows.length} embedded MQL rows, all-time inbound ${payload.allInbound}`
  );
}

main();
