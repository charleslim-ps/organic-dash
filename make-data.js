#!/usr/bin/env node
/**
 * organic-dash make-data — merges raw Looker MCP results into data.json.
 *
 * Usage:
 *   node make-data.js <trafficAiFile> <trafficTotalFile> <mqlContactsFile> <mqlMonthlyFile>
 *
 * Each argument is a JSON file holding either {result: [...]} (a saved MCP
 * tool-result) or a bare [...] array of rows. See REFRESH.md for the queries
 * that produce each input. Strips a UTF-8 BOM if present (never build these
 * files with PowerShell Out-File / ConvertTo-Json — BOM + array-wrapping
 * break JSON.parse).
 */

const fs = require('fs');
const path = require('path');

// Dashboard window: everything older than this is dropped at merge time.
// (Charles's call 2026-07-09: 12 months is enough; the all-time AI MQL
// history only starts 2025-03-24 anyway.)
const TRIM_DAYS = 365;

// AI-attributed MQLs that predate the rolling 5000-row contact window but
// fall inside TRIM_DAYS. Currently empty: the pre-window AI MQLs (first one
// 2025-03-24, found via a lead.utm_source AI-filtered query on 2026-07-09)
// are older than the 12-month window. If the contact window ever shrinks
// below TRIM_DAYS, re-run that query and add the missing rows here.
const HISTORICAL_AI_BACKFILL = [];

function readRows(p) {
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.result;
}

const [trafficAiFile, trafficTotalFile, mqlContactsFile, mqlMonthlyFile] = process.argv.slice(2);
if (!mqlMonthlyFile) {
  console.error('Usage: node make-data.js <trafficAiFile> <trafficTotalFile> <mqlContactsFile> <mqlMonthlyFile>');
  process.exit(1);
}

function addDays(iso, delta) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

const trafficTotalAll = readRows(trafficTotalFile);
const maxTrafficDate = trafficTotalAll.reduce((m, r) => {
  const d = String(r['google_analytics.event_date']).slice(0, 10);
  return d > m ? d : m;
}, '');
const trimCutoff = addDays(maxTrafficDate, -TRIM_DAYS);

let contacts = readRows(mqlContactsFile);
// The contact query caps at 5000 rows sorted by date desc, so the oldest
// returned day is usually partial — drop it to keep daily counts honest.
const minDate = contacts.reduce((m, r) => {
  const d = r['lead.mql_date_date'];
  return !m || d < m ? d : m;
}, null);
const capped = contacts.length >= 5000;
if (capped) contacts = contacts.filter((r) => r['lead.mql_date_date'] > minDate);
contacts = contacts.filter((r) => r['lead.mql_date_date'] >= trimCutoff);

const data = {
  generatedAt: new Date().toISOString(),
  trimCutoff,
  trafficDailyAi: readRows(trafficAiFile).filter((r) => String(r['google_analytics.event_date']).slice(0, 10) >= trimCutoff),
  trafficDailyTotal: trafficTotalAll.filter((r) => String(r['google_analytics.event_date']).slice(0, 10) >= trimCutoff),
  mqls: contacts,
  mqlMonthly: readRows(mqlMonthlyFile).filter((r) => String(r['lead.mql_date_month']) >= trimCutoff.slice(0, 7)),
  historicalAiBackfill: HISTORICAL_AI_BACKFILL.filter((r) => r['lead.mql_date_date'] >= trimCutoff),
};

const out = path.join(__dirname, 'data.json');
fs.writeFileSync(out, JSON.stringify(data), 'utf8');
console.log(
  `data.json: ${data.trafficDailyAi.length} AI traffic rows, ${data.trafficDailyTotal.length} total rows, ` +
    `${data.mqls.length} contact MQLs (coverage from ${capped ? '>' + minDate : minDate}), ` +
    `${data.mqlMonthly.length} monthly buckets, ${HISTORICAL_AI_BACKFILL.length} backfill AI rows`
);
