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

// AI-attributed MQLs that predate the rolling ~12-month contact window
// (the contact query caps at 5000 rows). One-time archaeology via a
// lead.utm_source AI-filtered query on 2026-07-09; the full AI MQL history
// started 2025-03-24. If the contact window's oldest date ever advances past
// rows still missing here, re-run that query and extend this list (REFRESH.md).
const HISTORICAL_AI_BACKFILL = [
  { 'lead.mql_date_date': '2025-03-31', 'lead.first_name': 'Shad', 'lead.last_name': 'Nelson', 'lead.email': 'shad.nelson@devz.ai', 'lead.company': 'Devz', 'lead.sub_source': 'chatgpt', 'lead.utm_source': 'chatgpt.com', 'lead.utm_medium': null, 'lead.form_name': 'Demo V4' },
  { 'lead.mql_date_date': '2025-03-26', 'lead.first_name': 'Phuong', 'lead.last_name': 'Rosa', 'lead.email': 'phuong.nguyen@journeyh.io', 'lead.company': 'Journeyhorizon', 'lead.sub_source': 'chatgpt', 'lead.utm_source': 'chatgpt.com', 'lead.utm_medium': null, 'lead.form_name': 'Demo V4 (multi step)' },
  { 'lead.mql_date_date': '2025-03-24', 'lead.first_name': 'Phuong', 'lead.last_name': 'Rosa', 'lead.email': 'phuong.nguyen@journeyh.io', 'lead.company': 'Journeyhorizon', 'lead.sub_source': 'chatgpt', 'lead.utm_source': 'chatgpt.com', 'lead.utm_medium': null, 'lead.form_name': 'Demo V4' },
];

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

let contacts = readRows(mqlContactsFile);
// The contact query caps at 5000 rows sorted by date desc, so the oldest
// returned day is usually partial — drop it to keep daily counts honest.
const minDate = contacts.reduce((m, r) => {
  const d = r['lead.mql_date_date'];
  return !m || d < m ? d : m;
}, null);
const capped = contacts.length >= 5000;
if (capped) contacts = contacts.filter((r) => r['lead.mql_date_date'] > minDate);

const data = {
  generatedAt: new Date().toISOString(),
  trafficDailyAi: readRows(trafficAiFile),
  trafficDailyTotal: readRows(trafficTotalFile),
  mqls: contacts,
  mqlMonthly: readRows(mqlMonthlyFile),
  historicalAiBackfill: HISTORICAL_AI_BACKFILL,
};

const out = path.join(__dirname, 'data.json');
fs.writeFileSync(out, JSON.stringify(data), 'utf8');
console.log(
  `data.json: ${data.trafficDailyAi.length} AI traffic rows, ${data.trafficDailyTotal.length} total rows, ` +
    `${data.mqls.length} contact MQLs (coverage from ${capped ? '>' + minDate : minDate}), ` +
    `${data.mqlMonthly.length} monthly buckets, ${HISTORICAL_AI_BACKFILL.length} backfill AI rows`
);
