# organic-dash — MCP refresh runbook

How a Claude session refreshes the dashboard **without any API credentials** —
all data comes from the Claude Looker MCP connector. Takes ~3 minutes.

## Artifact

The dashboard is a **private Claude Artifact**:
https://claude.ai/code/artifact/9f14f252-27cf-4285-bbdb-e3d39acadeca

Redeploy to that same URL by passing it as `url` to the Artifact tool.

## Steps

Run the four Looker MCP `query_explore` queries below. Large results are saved
automatically as tool-result files; if a result comes back inline, Write it to a
scratch JSON file yourself (raw `[...]` rows or the whole `{result: [...]}` object
— `make-data.js` accepts both). **Never build JSON files with PowerShell**
(`ConvertTo-Json` wraps arrays, `Out-File` adds a BOM; both break `JSON.parse`).

1. **AI traffic daily** — model `ops`, explore `google_analytics`
   - dimensions: `google_analytics.event_date`, `google_analytics.traffic_source__source`
   - measures: `google_analytics.sum_users`
   - filters: `google_analytics.event_date` = `36 months`, `google_analytics.timescale` = `DAY`,
     `google_analytics.traffic_source__source` =
     `%chatgpt%,%openai%,%perplexity%,claude.ai,%gemini.google%,copilot.com,poe.com,%phind%,notebooklm.google.com`
   - sorts: `google_analytics.event_date` · limit 10000

2. **Total traffic daily** — model `ops`, explore `google_analytics`
   - dimensions: `google_analytics.event_date` · measures: `google_analytics.sum_users`
   - filters: `google_analytics.event_date` = `36 months`, `google_analytics.timescale` = `DAY`
   - sorts: `google_analytics.event_date` · limit 10000

3. **MQL contacts** — model `salesforce`, explore `lead`
   - dimensions: `lead.mql_date_date`, `lead.first_name`, `lead.last_name`, `lead.email`,
     `lead.company`, `lead.sub_source`, `lead.utm_source`, `lead.utm_medium`, `lead.form_name`
   - measures: none
   - filters: `lead.mql_date_date` = `36 months`, `lead.status` = `-Holding`,
     `lead.lead_source` = `Inbound`
   - sorts: `lead.mql_date_date desc` · limit 15000
   - NOTE: the tool caps at 5000 rows (~12 rolling months). `make-data.js` handles the
     cap (drops the partial oldest day); the monthly query below supplies all-time counts.

4. **MQL monthly counts** — model `salesforce`, explore `lead`
   - dimensions: `lead.mql_date_month` · measures: `lead.count`
   - filters: same as step 3 · sorts: `lead.mql_date_month` · limit 100
   - Comes back inline — Write it to a scratch file.

5. **Merge:**
   `node make-data.js <aiTrafficFile> <totalTrafficFile> <mqlContactsFile> <mqlMonthlyFile>`
   (in this directory) → writes `data.json`.

6. **Render:** `node render.js` → writes `index.html` + `artifact.html`
   (interactive page: 7d/30d/90d/all-time filters, full-width chart, load-all MQL table).

7. **Redeploy:** call the Artifact tool with
   `file_path = <this dir>\artifact.html`, `favicon = 📊`, and
   `url = https://claude.ai/code/artifact/9f14f252-27cf-4285-bbdb-e3d39acadeca`.

8. Do **not** commit `data.json` / `index.html` / `artifact.html` — prospect PII,
   public repo. They are gitignored; leave them that way.

## Definitions

- **AI referrer regex** (in `render.js`): `chatgpt|openai|perplexity|claude\.ai|anthropic|gemini|copilot|phind|poe\.com|notebooklm`
  — no bare `you.com` (substring-matches peekyou.com).
- **MQL** = `salesforce::lead` with `mql_date` set, `lead_source = Inbound`, status not Holding
  (matches GTM Daily Pulse). All-time MQL data starts 2024-09; GA4 traffic starts 2023-08.
- **AI-attributed MQL** = regex match over `sub_source | utm_source | utm_medium | form_name`.
- **HISTORICAL_AI_BACKFILL** (in `make-data.js`): AI MQLs older than the rolling 5000-row
  contact window (earliest 2025-03-24). If the contact window's oldest date ever advances
  past AI rows not yet in the list, re-run the step-3 query with an extra filter
  `lead.utm_source` = `%chatgpt%,%openai%,%perplexity%,%claude%,%gemini%,%copilot%,%phind%,%poe%,%notebooklm%`
  and append the missing rows to the constant.
- Embedded contact detail: **all** AI-attributed rows + non-AI rows in the last 90 days;
  older non-AI MQLs appear in counts only (page-size control).
