#!/usr/bin/env node
/**
 * organic-dash crawl-pull — fetches AI crawler traffic from the Cloudflare
 * GraphQL MCP server (https://graphql.mcp.cloudflare.com/mcp) over plain
 * HTTP JSON-RPC, reusing the OAuth token the Claude client stored when the
 * server was authorized via /mcp. No Cloudflare API key involved.
 *
 * Usage:  node crawl-pull.js            -> writes crawl-raw.json
 *
 * Token lookup order: $CLAUDE_CONFIG_DIR, ~/.claude, ~/.claude-ps
 * (.credentials.json, mcpOAuth key starting "cloudflare-graphql|").
 * If the stored access token is expired, tries an OAuth refresh grant
 * in-memory (never writes the credentials file).
 *
 * Data: zone partnerstack.com, dataset httpRequestsAdaptiveGroups,
 * verifiedBotCategory in [AI Crawler, AI Assistant, AI Search],
 * requestSource eyeball, grouped by date + userAgent + category.
 * Host-filtered to the marketing site (HOST below) — zone-wide numbers are
 * dominated by js.partnerstack.com (tracking assets) and product/partner-page
 * subdomains (dash., api., <partner>.partnerstack.com), which aren't content
 * crawl demand. Charles's call 2026-07-09: apex hostname only
 * (www.partnerstack.com is just a redirect, ~9% of apex volume — excluded).
 * Cloudflare caps queries at 32 days and retention at ~90 days, so the
 * pull runs in 30-day chunks from (today - RETENTION_DAYS) to yesterday.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MCP_URL = 'https://graphql.mcp.cloudflare.com/mcp';
const ACCOUNT_ID = 'e01cc42974eee44a8e992b8e7df25a19'; // PartnerStack
const ZONE_TAG = 'ea63cacb9a9d5c3728d3f9f5a007f437'; // partnerstack.com
const HOST = 'partnerstack.com'; // marketing site only, no subdomains
const RETENTION_DAYS = 88; // Cloudflare allows 12w6d (~90); stay under it
const CHUNK_DAYS = 30; // max span per query is 4w4d (32)

function loadTokenEntry() {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude-ps')].filter(Boolean);
  const candidates = [];
  for (const d of dirs) {
    const f = path.join(d, '.credentials.json');
    if (!fs.existsSync(f)) continue;
    const creds = JSON.parse(fs.readFileSync(f, 'utf8'));
    const hit = Object.entries(creds.mcpOAuth || {}).find(([k]) => k.startsWith('cloudflare-graphql|'));
    if (hit && hit[1].accessToken) candidates.push(hit[1]);
  }
  if (!candidates.length) throw new Error('no cloudflare-graphql OAuth token found — authorize the MCP server via /mcp in a Claude session');
  // Prefer the freshest token.
  candidates.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  return candidates[0];
}

async function freshToken() {
  const entry = loadTokenEntry();
  if (!entry.expiresAt || Date.now() < entry.expiresAt - 60_000) return entry.accessToken;
  if (!entry.refreshToken) throw new Error('token expired and no refresh token available — re-authorize via /mcp');
  const origin = new URL(entry.serverUrl || MCP_URL).origin;
  const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: entry.refreshToken, client_id: entry.clientId }),
  });
  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status}) — re-authorize via /mcp`);
  const tok = await res.json();
  return tok.access_token;
}

async function rpc(body, sessionId, token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!body.id) return { sid }; // notification, no response expected
  const datas = text.split('\n').filter((l) => l.startsWith('data: '));
  const payload = datas.length ? datas[datas.length - 1].slice(6) : text;
  return { json: JSON.parse(payload), sid };
}

function isoDaysAgo(n) {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}

function addDays(iso, delta) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

function crawlQuery(from, to) {
  return `query { viewer { zones(filter: {zoneTag: "${ZONE_TAG}"}) {
    httpRequestsAdaptiveGroups(
      filter: {date_geq: "${from}", date_leq: "${to}", requestSource: "eyeball",
               clientRequestHTTPHost: "${HOST}",
               verifiedBotCategory_in: ["AI Crawler", "AI Assistant", "AI Search"]},
      limit: 5000, orderBy: [date_ASC]
    ) { count dimensions { date userAgent verifiedBotCategory } }
  } } }`;
}

(async () => {
  const token = await freshToken();
  const init = await rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'organic-dash-crawl-pull', version: '1.0' } },
    },
    null,
    token
  );
  const sid = init.sid;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid, token);

  const end = isoDaysAgo(1); // align with GA4, which lags a day
  const start = isoDaysAgo(RETENTION_DAYS);
  const rows = [];
  for (let from = start; from <= end; from = addDays(from, CHUNK_DAYS)) {
    const to = addDays(from, CHUNK_DAYS - 1) < end ? addDays(from, CHUNK_DAYS - 1) : end;
    const call = await rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'graphql_query', arguments: { account_id: ACCOUNT_ID, query: crawlQuery(from, to) } },
      },
      sid,
      token
    );
    let text = (call.json.result.content || [])[0]?.text || '';
    const cut = text.indexOf('\n**[Open in GraphQL Explorer]');
    if (cut > 0) text = text.slice(0, cut).trim();
    const parsed = JSON.parse(text);
    if (parsed.errors && parsed.errors.length) throw new Error(`GraphQL error for ${from}..${to}: ${JSON.stringify(parsed.errors[0].message)}`);
    const groups = parsed.data.viewer.zones[0].httpRequestsAdaptiveGroups;
    if (groups.length >= 5000) console.warn(`WARNING: chunk ${from}..${to} hit the 5000-row limit; counts may be incomplete`);
    for (const g of groups) {
      rows.push({ date: g.dimensions.date, userAgent: g.dimensions.userAgent, category: g.dimensions.verifiedBotCategory, count: g.count });
    }
    console.log(`${from}..${to}: ${groups.length} rows`);
  }

  // The apex host only started routing through this zone ~2026-05-26, so the
  // early window can be structurally empty — report coverage from the first
  // actual data day, not the queried start.
  const actualStart = rows.length ? rows[0].date : start;
  const out = path.join(__dirname, 'crawl-raw.json');
  fs.writeFileSync(out, JSON.stringify({ pulledAt: new Date().toISOString(), zone: 'partnerstack.com', host: HOST, start: actualStart, queriedStart: start, end, rows }), 'utf8');
  console.log(`crawl-raw.json: ${rows.length} rows, ${actualStart}..${end} (queried from ${start})`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
