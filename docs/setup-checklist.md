# Full setup checklist — Discord Linear Bot

Everything required for Linear commands, plan/`go`, `/deploy`, and automatic commit reviews.

---

## 1. Fine-grained GitHub PAT

Create at **GitHub → Settings → Developer settings → Fine-grained personal access tokens**.

| Setting | Value |
|---------|--------|
| Resource owner | `TechFlow-Labs` (and add `semantic-software/EmblemTameiaki` if `/deploy` uses that org) |
| Repository access | **All repositories** you want the bot to touch, **or** select each repo explicitly |

### Required permissions

| Permission | Access | Used for |
|------------|--------|----------|
| **Contents** | Read and write | `go` (branches, commits, files), commit review (read diffs), n8n `list repos` |
| **Issues** | Read and write | Plan tracking issues at plan time + `go` |
| **Pull requests** | Read and write | `go` opens PRs |
| **Actions** | Read and write | `/deploy` triggers `ci.yml` via `workflow_dispatch` |
| **Metadata** | Read | Implicit (always on) |

You do **not** need Gist, Packages, or Webhooks PAT scopes — GitHub webhooks are configured in the repo/org UI and call your bridge over HTTP.

### Repos to include on the token

At minimum, add every repo you will:

- `plan … in repo-name` / `go` against (`TechFlow-Labs/*`)
- Receive **push** webhooks from (commit review)
- `/deploy` against (`semantic-software/EmblemTameiaki` unless you change `GITHUB_REPO`)

---

## 2. `.env` on the bridge machine

Copy `.env.example` → `.env` and fill in:

```bash
# Discord
DISCORD_TOKEN=
BOT_USER_ID=
DISCORD_GUILD_ID=

# n8n
N8N_WEBHOOK=https://n8n.techflowlabs.gr/webhook/discord-linear-bot
N8N_API_KEY=

# Linear
LINEAR_WORKSPACE=techflowlabs

# GitHub
GITHUB_ORG=TechFlow-Labs
GITHUB_TOKEN=ghp_...your new PAT...
GITHUB_REPO=semantic-software/EmblemTameiaki

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o

# Commit review
COMMIT_REVIEW_ENABLED=true
GITHUB_WEBHOOK_SECRET=choose-a-long-random-string
WEBHOOK_PORT=3847
WEBHOOK_PUBLIC_URL=https://your-public-host/github/webhook
DISCORD_COMMIT_SUMMARY_CHANNEL=Commit-Summary
```

After changing `GITHUB_TOKEN`, also re-bake it into n8n:

```bash
npm run patch:n8n
```

Then restart the bridge:

```bash
npm start
```

Startup should show:

```
GitHub execute: on | Commit review: on
[webhook] listening on :3847 — configure GitHub → https://your-public-host/github/webhook
```

---

## 3. Discord server

### Bot (Developer Portal)

- **Message Content Intent** enabled
- Bot invited to your server with permissions: Send Messages, Read Message History, Use Slash Commands
- For commit reviews: **View Channel** + **Send Messages** in `#Commit-Summary`

### Channels & roles

| Item | Purpose |
|------|---------|
| `#Commit-Summary` | Bot posts AI commit review summaries here |
| Roles `Developer` / `Admin` | Required for `/deploy` |

Create `#Commit-Summary` (exact name, or set `DISCORD_COMMIT_SUMMARY_CHANNEL_ID`).

### Slash commands

With `DISCORD_GUILD_ID` set, `/n8n-linear` and `/deploy` register on bot startup.

---

## 4. n8n workflow

Workflow: **Discord → Linear Bot** on `n8n.techflowlabs.gr`.

- Must be **Active**
- Linear credentials connected (n8n AI parser may use OpenAI or another provider separately)
- `GITHUB_TOKEN` embedded via `node scripts/patch-bridge-flow.js` whenever the PAT changes

---

## 5. Commit review — GitHub webhook

The bridge runs a small HTTP server (`WEBHOOK_PORT`, default **3847**).

### Expose it publicly

GitHub must reach your bridge. Options:

- Run the bridge on a VPS with a public URL
- **Cloudflare Tunnel** / **ngrok** pointing to `localhost:3847`

Set `WEBHOOK_PUBLIC_URL` to the public base (no trailing slash), e.g. `https://bridge.techflowlabs.gr`.

### Configure webhook (per repo or org)

**GitHub → Repository (or Organization) → Settings → Webhooks → Add webhook**

| Field | Value |
|-------|--------|
| Payload URL | `{WEBHOOK_PUBLIC_URL}/github/webhook` |
| Content type | `application/json` |
| Secret | Same as `GITHUB_WEBHOOK_SECRET` in `.env` |
| Events | **Just the push event** |

Repeat for each repo, or use one **organization** webhook for all repos.

### What happens on push

1. GitHub sends `push` to the bridge
2. Bridge verifies the HMAC signature
3. For each distinct commit, fetches the diff via GitHub API
4. OpenAI reviews the diff for bugs / risks
5. Summary posts to `#Commit-Summary`

Optional filter — only review specific repos:

```bash
COMMIT_REVIEW_REPOS=wed-main-mvp,web-video-call-transcription
```

---

## 6. Feature matrix (what needs what)

| Feature | DISCORD_* | N8N_* | GITHUB_TOKEN | OPENAI | Webhook |
|---------|-----------|-------|--------------|-----------|---------|
| Linear commands (DM/slash) | ✓ | ✓ | — | n8n | — |
| `plan` / pending plan | ✓ | ✓ | read (issues) | n8n | — |
| `go` (AI → PR) | ✓ | — | read/write | ✓ | — |
| `/deploy` | ✓ | — | actions write | — | — |
| Commit review | ✓ + `#Commit-Summary` | — | read | ✓ | ✓ |

---

## 7. Verification

```bash
# Bridge health (local)
curl http://localhost:3847/health

# After PAT + patch
npm run patch:n8n
npm start
```

In Discord:

1. DM: `list repos` → should list `TechFlow-Labs` repos
2. DM: `plan fix ENG-10 in wed-main-mvp` → Linear doc + GitHub issue
3. DM: `go` → PR (if plan pending)
4. Push a commit to a watched repo → review appears in `#Commit-Summary`
5. `/deploy type:dev branch:feature/test` (as Developer) → Actions run

---

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `GitHub execute: off` | Set `GITHUB_TOKEN` + `OPENAI_API_KEY`, restart bridge |
| `Commit review: off` | `COMMIT_REVIEW_ENABLED=true`, set secret + guild/channel |
| Webhook 401 | `GITHUB_WEBHOOK_SECRET` mismatch between GitHub and `.env` |
| No Discord post | Create `#Commit-Summary`, check bot permissions |
| 403 on `go` / plan issue | Add repo to PAT with Issues + Contents write |
| 403 on `/deploy` | PAT needs Actions write on `GITHUB_REPO` |
| n8n `list repos` empty | Re-run `npm run patch:n8n` after PAT change |
| Reviews never arrive | `WEBHOOK_PUBLIC_URL` must be reachable from GitHub |
