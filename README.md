# discord-bot

Discord bot bridge for Emblem Tamiaki: slash commands, n8n/Linear integration, sales support (RAG over EmblemTameiaki-Knowledge), app status, dev assistant, and auto-escalation.

## Quick start

```bash
cp .env.example .env   # fill in tokens and paths
npm install
npm run daemon:start   # keeps running — auto-restarts on crash
```

For one-off debugging use `npm start` instead.

### Always online (recommended)

[PM2](https://pm2.keymetrics.io/) keeps the bot running in the background and restarts it if it crashes.

```bash
npm run daemon:start    # start in background
npm run daemon:status   # is it online?
npm run daemon:logs     # tail logs
npm run daemon:restart  # after .env changes
```

**Start on Mac login** (once):

```bash
npm run daemon:setup-macos
# Copy/paste the sudo command it prints, then:
npm run daemon:save
```

This installs:
- PM2 background process (auto-restart on crash)
- LaunchAgent health check every 2 min (recovers after sleep / network blips)
- Optional `sleepwatcher` hook for faster wake recovery (`brew install sleepwatcher`)

The bot will stay online **unless the Mac sleeps or reboots**. After wake, it reconnects within ~2 minutes automatically.

See [SETUP.md](SETUP.md) and [docs/setup-checklist.md](docs/setup-checklist.md) for full configuration.

## Main commands

| Command | Purpose |
| --- | --- |
| `/help` | Greek help for all slash commands |
| `/sales-support` | Employee Q&A from knowledge base + code |
| `/app-status` | Recent features, risks, app status |
| `/dev` | Developer implementation plan |
| `/github-issue` | Create GitHub issues |
| `/deploy` | Trigger deploy workflow |
| `/n8n-linear` | Forward to n8n / Linear |
| `/leads` | Find lead Excel files on Google Drive (read-only + AI match) |

## Daily codebase brief

With `CODEBASE_BRIEF_ENABLED=true`, the bot posts **one** `.docx` to `#tameiaki-ai-briefs` every day at **09:00 Europe/Athens**. That file includes:

1. **Day plan** (AI) — what was done + prioritized work for today  
2. **Commits table** — Word table with commit title · author · date  
3. **Stale branches** — full list of branches idle ≥7 days  

It analyzes the last 3 days of commits/issues/PRs across active branches.

## Knowledge base

Point `KNOWLEDGE_REPO_PATH` at a local clone of [EmblemTameiaki-Knowledge](https://github.com/semantic-software/EmblemTameiaki-Knowledge).

Recommended branch for `/sales-support`:

```env
KNOWLEDGE_REPO_BRANCH=ai/sales-support-knowledge
```

After changing docs or branch (only needed if auto-reindex is off):

```bash
npm run kb:reindex
```

### Auto-reindex (default on)

When `KNOWLEDGE_REPO_PATH` and `OPENAI_API_KEY` are set, the bot:

1. **On startup** — compares the knowledge branch SHA to the last indexed SHA; reindexes if needed
2. **Every 2 minutes** — `git fetch` + same check (safety net)
3. **On GitHub push** — if `GITHUB_WEBHOOK_SECRET` is set, pushes to `EmblemTameiaki-Knowledge` that touch `docs/` trigger reindex within ~8s

Add a webhook on **EmblemTameiaki-Knowledge** → `https://your-bot-host:3847/github/webhook` (same secret as commit review). Watched branches: `ai/sales-support-knowledge`, `restructure/wiki-structure`.

Manual sync:

```bash
npm run kb:sync
```

## Scripts

```bash
npm start                 # foreground (debugging)
npm run daemon:start      # background + auto-restart (production)
npm run daemon:status
npm run daemon:logs
npm run daemon:restart
npm run slash:refresh     # re-register slash commands
npm run kb:reindex        # rebuild vector index (full)
npm run kb:sync           # sync index if knowledge SHA changed
npm run review:last       # review latest commit
```
