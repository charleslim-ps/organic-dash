# organic-dash

Dashboard showing **LLM referral traffic → MQL conversion** for PartnerStack.

**Live (active path):** private Claude Artifact, refreshed daily by a Claude scheduled task —
see [REFRESH.md](REFRESH.md). Contains contact-level PII, which is why it is **not** on
GitHub Pages: this repo is public, and Pages sites are always public.

## Active path — MCP, no credentials

1. A Claude scheduled task (`organic-dash-refresh`, daily 12 AM) pulls traffic from the
   Looker MCP (`ops::google_analytics`) and MQLs from `salesforce::lead`.
2. Writes raw rows to `data.json` (gitignored — PII).
3. `node render.js` → `index.html` + `artifact.html` (both gitignored — PII).
4. Redeploys the private Claude Artifact. Definitions + exact queries: [REFRESH.md](REFRESH.md).

## Dormant path — direct APIs + GitHub Pages

`build.js` + `.github/workflows/refresh.yml` implement the original design: Looker + HubSpot
REST APIs → commit `index.html` → GitHub Pages. It works but needs `LOOKER_CLIENT_ID`/
`LOOKER_CLIENT_SECRET`/`HUBSPOT_API_TOKEN` repo secrets, and must only be revived with a
PII-free render (or a private hosting story). Docs below cover this path.

## Quick start (local)

```powershell
cd projects\organic-dash

$env:LOOKER_CLIENT_ID = "..."
$env:LOOKER_CLIENT_SECRET = "..."
$env:HUBSPOT_API_TOKEN = "..."

node build.js
# open index.html
```

Optional:

```powershell
$env:PERIOD_DAYS = "30"
$env:ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/..."
```

## Looker API credentials

Generate at: https://reporting.partnerstack.com/admin/users

1. Open your user → **Edit API Keys** → **New API Key**.
2. Copy **Client ID** and **Client Secret** (secret shown once).

## Traffic query

The default traffic query is committed as [`query.json`](query.json): daily users by
`traffic_source__source` from the `ops::google_analytics` explore (same source as the
GTM Daily Pulse "Website Traffic by Week" tile). `{{PERIOD_DAYS}}` is substituted at
build time. `build.js` classifies AI referrers (chatgpt, perplexity, claude.ai, gemini,
copilot, …) via regex, so no Looker-side filter is needed.

Overrides, in priority order:

1. `LOOKER_LOOK_ID` — run a saved Look instead
2. `LOOKER_QUERY_JSON` — inline query JSON
3. `query.json` — committed default

## HubSpot token

Create a **Private App** in HubSpot with scope:

- `crm.objects.contacts.read`

Copy the access token.

## GitHub Secrets (repo settings)

| Secret | Required | Notes |
|---|---|---|
| `LOOKER_CLIENT_ID` | yes | Looker API |
| `LOOKER_CLIENT_SECRET` | yes | Looker API |
| `HUBSPOT_API_TOKEN` | yes | Private app token |
| `LOOKER_LOOK_ID` | no | Saved traffic Look ID (default: committed `query.json`) |
| `ZAPIER_WEBHOOK_URL` | no | Ping after successful build |

Optional **Variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Default |
|---|---|
| `LOOKER_BASE_URL` | `https://reporting.partnerstack.com` |
| `PERIOD_DAYS` | `30` |

## GitHub Pages

Settings → Pages → Source: **Deploy from branch** → `main` → `/` (root).

The site serves `index.html` from the repo root.

## Manual workflow run

Actions → **Refresh dashboard** → **Run workflow**.

## Repo setup (SSH)

This workspace uses the PartnerStack GitHub account only:

```bash
git remote add origin git@github-ps:charleslim-ps/organic-dash.git
```

Pre-push guard blocks non-`charleslim-ps` / `partnerstack` destinations.

## Related

- Context doc: `../context/llm-geo-dashboard.md` in claude-ps workspace
- Slack commands: `@charles-ai traffic` / `mql` (Looker PNG via inbound Zap — separate)
