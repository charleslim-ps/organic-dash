# organic-dash — MCP refresh runbook

How a Claude session refreshes the dashboard **without any API credentials** —
all data comes from the Claude MCP connectors (Looker). Takes ~2 minutes.

## Artifact

The dashboard is a **private Claude Artifact**:
https://claude.ai/code/artifact/9f14f252-27cf-4285-bbdb-e3d39acadeca

Redeploy to that same URL by passing it as `url` to the Artifact tool.

## Steps

1. **Traffic daily (Looker MCP `query_explore`)** — save result rows as `trafficDaily`:
   - model `ops`, explore `google_analytics`
   - dimensions: `google_analytics.event_date`, `google_analytics.traffic_source__source`
   - measures: `google_analytics.sum_users`
   - filters: `google_analytics.event_date` = `30 days`, `google_analytics.timescale` = `DAY`,
     `google_analytics.traffic_source__source` =
     `%chatgpt%,%openai%,%perplexity%,claude.ai,%gemini.google%,copilot.com,poe.com,%phind%,notebooklm.google.com`
   - sorts: `google_analytics.event_date`

2. **Totals by channel (Looker MCP `query_explore`)** — save rows as `totalsBySource`:
   - model `ops`, explore `google_analytics`
   - dimensions: `google_analytics.source_medium`
   - measures: `google_analytics.sum_users`
   - filters: `google_analytics.event_date` = `30 days`, `google_analytics.timescale` = `DAY`

3. **MQLs (Looker MCP `query_explore`)** — save rows as `mqls`:
   - model `salesforce`, explore `lead`
   - dimensions: `lead.mql_date_date`, `lead.first_name`, `lead.last_name`, `lead.email`,
     `lead.company`, `lead.lead_source`, `lead.sub_source`, `lead.utm_source`,
     `lead.utm_medium`, `lead.form_name`
   - measures: none
   - filters: `lead.mql_date_date` = `30 days`, `lead.status` = `-Holding`,
     `lead.lead_source` = `Inbound`
   - sorts: `lead.mql_date_date desc`
   - limit 500 (check row count; page if it hits the limit)

4. **Write `data.json`** in this directory (raw MCP field names, no transformation):

   ```json
   {
     "generatedAt": "<ISO timestamp>",
     "periodDays": 30,
     "totalsBySource": [/* step 2 rows */],
     "trafficDaily":   [/* step 1 rows */],
     "mqls":           [/* step 3 rows */]
   }
   ```

   Large MCP results land in a tool-results file — merge with a small node script
   (see `scratchpad make-data.js` pattern), **not PowerShell** (`ConvertTo-Json`
   wraps arrays and `Out-File` adds a BOM; both break `JSON.parse`).

5. **Render:** `node render.js` → writes `index.html` + `artifact.html`.

6. **Redeploy the artifact:** call the Artifact tool with
   `file_path = <this dir>\artifact.html`, `favicon = 📊`, and
   `url = https://claude.ai/code/artifact/9f14f252-27cf-4285-bbdb-e3d39acadeca`.

7. Do **not** commit `data.json` / `index.html` / `artifact.html` — they contain
   prospect PII and the repo is public. They are gitignored; leave them that way.

## Definitions

- **AI referrer regex** (in `render.js`): `chatgpt|openai|perplexity|claude\.ai|anthropic|gemini|copilot|phind|poe\.com|notebooklm`
  — no bare `you.com` (substring-matches peekyou.com).
- **MQL** = `salesforce::lead` with `mql_date` set, `lead_source = Inbound`, status not Holding
  (matches GTM Daily Pulse tiles).
- **AI-attributed MQL** = regex match over `sub_source | utm_source | utm_medium | form_name`.
