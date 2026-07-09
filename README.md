# organic-dash

Static GitHub Pages dashboard showing **LLM referral traffic → MQL conversion** for PartnerStack.

**Live site:** https://charleslim-ps.github.io/organic-dash/

## How it works

1. `build.js` authenticates to Looker (`reporting.partnerstack.com`) and HubSpot.
2. Pulls AI referral sessions from a saved Looker Look.
3. Pulls MQL contacts from HubSpot and flags AI-influenced attribution.
4. Writes a self-contained `index.html` (no npm deps).
5. GitHub Action runs every **Monday** (or on demand), commits fresh `index.html`.

## Quick start (local)

```powershell
cd projects\organic-dash

$env:LOOKER_CLIENT_ID = "..."
$env:LOOKER_CLIENT_SECRET = "..."
$env:HUBSPOT_API_TOKEN = "..."
$env:LOOKER_LOOK_ID = "..."      # saved Look for AI referral traffic

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

Save the Look you want to use (e.g. from GTM Daily Pulse → Website Traffic, filtered to AI referrers). Note the Look ID from the URL: `/looks/123`.

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
| `LOOKER_LOOK_ID` | yes | Saved traffic Look ID |
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
