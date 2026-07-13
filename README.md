# discord-bot

Discord bot bridge for Emblem Tamiaki: slash commands, n8n/Linear integration, sales support (RAG over EmblemTameiaki-Knowledge), app status, dev assistant, and auto-escalation.

## Quick start

```bash
cp .env.example .env   # fill in tokens and paths
npm install
npm start
```

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

With `CODEBASE_BRIEF_ENABLED=true`, the bot posts a **dev day-plan** brief to `#tameiaki-ai-briefs` every day at **09:00 Europe/Athens**. It analyzes the last 3 days of commits/issues/PRs and outputs what was done + prioritized tasks for **today** as a `.docx` file.

## Knowledge base

Point `KNOWLEDGE_REPO_PATH` at a local clone of [EmblemTameiaki-Knowledge](https://github.com/semantic-software/EmblemTameiaki-Knowledge).

Recommended branch for `/sales-support`:

```env
KNOWLEDGE_REPO_BRANCH=ai/sales-support-knowledge
```

After changing docs or branch:

```bash
npm run kb:reindex
```

## Scripts

```bash
npm start                 # run bot
npm run slash:refresh     # re-register slash commands
npm run kb:reindex        # rebuild vector index
npm run review:last       # review latest commit
```
