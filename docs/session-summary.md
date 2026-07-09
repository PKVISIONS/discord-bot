# Discord Linear Bot — Session Summary

> Summary of work done across this conversation (June–July 2026).  
> Project: `~/Projects/discord-linear-bot`  
> Org: **TechFlow-Labs** · App repo: **`semantic-software/EmblemTameiaki`**

---

## What this project is

A **Discord bridge** that connects employees to:

- **n8n / Linear** workflows (`/n8n-linear`, plan/go flows)
- **GitHub Actions** deploys (`/deploy`)
- **AI commit reviews** posted to `#commit-summary`
- **Sales & customer support** for internal staff (`/sales-support`) — Greek, customer-friendly answers backed by product knowledge, live code activity, and stored commit reviews

---

## Timeline of requests & deliverables

| # | Request | What was built |
|---|---------|----------------|
| 1 | PAT setup, commit review → `#commit-summary` | GitHub webhook + AI review pipeline, Discord channel poster |
| 2 | Interactive **commit summary** (repo → branch picker) | `commit-summary-flow.js` with branch menus and latest-commit previews |
| 3 | Replace **Anthropic** with **OpenAI** | `lib/openai.js` (`gpt-4o`), removed Anthropic dependency |
| 4 | **`/sales-support`** for employees | Greek two-tier answers: internal notes + «Πες στον πελάτη έτσι» |
| 5 | Improve prompts (no `.md`/tech in customer text) | Prompt engineering in `sales-support.js` |
| 6 | Integrate **EmblemTameiaki-Knowledge** | `knowledge-base.js` loads local knowledge repo docs |
| 7 | **Unified EmblemTameiaki context** | Knowledge + GitHub code activity + stored commit reviews |
| 8 | **Auto-review** new commits | Poll/webhook → AI review → Discord + persistent store |
| 9 | Use **`restructure/wiki-structure`** knowledge branch | Git-based doc loading without checkout |
| 10 | Consider **all branches** in answers | Full branch catalog in code activity (57 branches) |
| 11 | Show **sources** for employees only | Reply-to-message source lookup system |
| 12 | Make sources **consistent** (reply, not keywords) | Context store + `πηγές` / `από πού` reply handler |

---

## Architecture overview

```
Discord (DM / slash / mentions)
        │
        ▼
  discord-bridge.js
        │
        ├── /n8n-linear ──────────► n8n webhook ──► Linear
        ├── /deploy ──────────────► GitHub Actions
        ├── commit summary ───────► commit-summary-flow → commit-review → Discord
        ├── /sales-support ───────► sales-support → OpenAI
        │                              ├── knowledge-base (wiki docs)
        │                              ├── code-activity (all branches)
        │                              ├── commit-review-store (saved reviews)
        │                              └── sales-support-context-store (reply sources)
        ├── auto-commit-review ─────► poll GitHub → review → Discord + store
        └── webhook-server ─────────► GitHub push → review → Discord + store
```

---

## Key features (current state)

### 1. Commit review & `#commit-summary`

**Manual**
- Say `commit summary` in DM → pick repo → pick branch → AI reviews latest commit
- `npm run review:last` for one-off CLI review

**Automatic**
- **`COMMIT_AUTO_REVIEW=true`** — polls EmblemTameiaki every 10 min for new commits on `main`
- On startup: backfills up to 8 unreviewed commits (posts to Discord)
- **Webhook path** (optional): `COMMIT_REVIEW_ENABLED=true` + `GITHUB_WEBHOOK_SECRET` for instant push reviews

**Storage (reusable)**
- `data/reviews/semantic-software__EmblemTameiaki.json`
- Each entry: SHA, branch, message, structured AI review, Discord message text
- Used by `/sales-support` unified context and sales answers

### 2. `/sales-support`

**Purpose:** Help **employees** answer customer questions accurately, in plain Greek.

**Output structure**
- **Σύντομα για εσένα** — internal, can be more technical
- **Πες στον πελάτη έτσι** — ready-to-send, simple, no jargon
- **Αν δεν είσαι σίγουρος** — what to escalate internally

**Context sources (for EmblemTameiaki)**
1. **EmblemTameiaki-Knowledge** — wiki docs from branch `restructure/wiki-structure` (89 docs, read via git, no checkout)
2. **GitHub code activity** — all 57 branches (latest commit per branch), merged PRs, main history
3. **Stored AI commit reviews** — up to 40 recent reviews from `data/reviews/`
4. **FAQ** — `data/faq/emblem-tamiaki.md`

**Sources for employees (reply system)**
- Sources are **not** inlined in the main answer
- Every answer saves source metadata linked to the bot message ID
- **Reply** to the bot message with `πηγές`, `από πού το βρήκες;`, `sources`, etc.
- Bot returns **Πηγές (εσωτερικά)** with docs, FAQ #s, branches, PRs, commit reviews
- Stored in `data/sales-support-contexts.json` (7-day TTL)

### 3. Knowledge base (wiki-structure)

- Local clone: `KNOWLEDGE_REPO_PATH` (e.g. `~/Documents/GitHub/EmblemTameiaki-Knowledge`)
- Branch: `KNOWLEDGE_REPO_BRANCH=restructure/wiki-structure`
- Loaded via `git show` / `git ls-tree` — working tree can stay on `main`
- Legacy doc names (`Overview.md`, etc.) map to new wiki paths (`product/overview.md`, etc.)

### 4. Code activity (all branches)

- Fetches **every branch** (paginated, no 25-branch cap by default)
- Includes latest commit per branch in AI context
- Env tuning: `CODE_ACTIVITY_BRANCHES=0` (all), `CODE_ACTIVITY_DEFAULT_COMMITS`, `CODE_ACTIVITY_MERGED_PRS`, `CODE_ACTIVITY_MAX_CHARS`

---

## Important files

| File | Purpose |
|------|---------|
| `discord-bridge.js` | Main entry — slash commands, DMs, webhook server, auto-review |
| `lib/openai.js` | OpenAI Chat Completions |
| `lib/commit-review.js` | AI single-commit review + save to store |
| `lib/commit-review-store.js` | Per-repo JSON review persistence |
| `lib/commit-summary-flow.js` | Interactive repo/branch picker |
| `lib/auto-commit-review.js` | Poll + backfill auto-review |
| `lib/webhook-server.js` | GitHub push webhook handler |
| `lib/discord-commit-summary.js` | Post to `#commit-summary` |
| `lib/knowledge-base.js` | Load/score EmblemTameiaki-Knowledge docs |
| `lib/code-activity.js` | GitHub branches, commits, merged PRs |
| `lib/unified-emblem-context.js` | Merge knowledge + code + reviews for sales-support |
| `lib/sales-support.js` | Greek sales/support prompts + OpenAI call |
| `lib/sales-support-delivery.js` | Deliver answers + reply-to-sources handler |
| `lib/sales-support-context-store.js` | Message ID → source metadata |
| `lib/sales-support-sources.js` | Detect source follow-up queries |
| `lib/sales-support-flow.js` | Repo picker when repo omitted |
| `lib/product-faq.js` | FAQ matching from markdown |
| `data/faq/emblem-tamiaki.md` | Product FAQ catalog |
| `data/reviews/*.json` | Stored commit reviews |
| `data/sales-support-contexts.json` | Reply-to-sources context index |

---

## Environment variables (`.env`)

### Core
```bash
DISCORD_TOKEN=
BOT_USER_ID=
DISCORD_GUILD_ID=
N8N_WEBHOOK=
N8N_API_KEY=
GITHUB_ORG=TechFlow-Labs
GITHUB_TOKEN=
GITHUB_REPO=semantic-software/EmblemTameiaki
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
DM_ONLY=true
```

### Commit review & Discord channel
```bash
DISCORD_COMMIT_SUMMARY_CHANNEL=commit-summary
COMMIT_AUTO_REVIEW=true
COMMIT_AUTO_REVIEW_REPO=semantic-software/EmblemTameiaki
COMMIT_AUTO_REVIEW_POLL_MINUTES=10
COMMIT_AUTO_REVIEW_BACKFILL=8
# Optional webhook (instant on push):
# COMMIT_REVIEW_ENABLED=true
# GITHUB_WEBHOOK_SECRET=
# WEBHOOK_PORT=3847
# WEBHOOK_PUBLIC_URL=
```

### Knowledge & sales-support
```bash
KNOWLEDGE_REPO_PATH=/Users/.../EmblemTameiaki-Knowledge
KNOWLEDGE_REPO_BRANCH=restructure/wiki-structure
# KNOWLEDGE_REPO_FETCH=true
# CODE_ACTIVITY_BRANCHES=0
# CODE_ACTIVITY_DEFAULT_COMMITS=40
# CODE_ACTIVITY_MERGED_PRS=50
```

**Note:** Use `dotenv.config({ override: true })` so `.env` wins over shell env (old PAT issue).

---

## Commands & how to test

```bash
# Start bridge
npm start

# Manual commit review (CLI)
npm run review:last
```

**Discord**
```
/n8n-linear ...
/deploy type:... branch:...
/sales-support repo:EmblemTameiaki question:Πώς δουλεύει το SoftPOS;
commit summary
sales support in EmblemTameiaki ...
```

**Sources follow-up**
1. Get a `/sales-support` answer
2. Reply to that bot message: `πηγές` or `από πού το βρήκες;`

---

## Fixes applied during session

| Issue | Fix |
|-------|-----|
| PAT 403 on EmblemTameiaki | Add repo to fine-grained PAT scopes |
| Shell env overriding `.env` | `dotenv` with `override: true` |
| Discord 2000 char limit on branch list | Truncate preview text in commit summary |
| Generic/repetitive sales answers | FAQ + stronger prompts |
| Customer answers too technical | Two-tier prompt (internal vs customer) |
| 0 stored reviews in unified context | Reviews saved on every `reviewCommit()` run |
| Only 25 branches in context | All branches + tip commit per branch |
| Flat `main` knowledge only | `restructure/wiki-structure` via git |
| Inconsistent source display | Reply-to-message + persistent context store |

---

## Data flows

### Commit review → reuse
```
GitHub commit (push or poll)
    → reviewCommit() → OpenAI
    → saveCommitReview() → data/reviews/{repo}.json
    → postCommitSummary() → #commit-summary
    → getRecentReviewsForRepo() → /sales-support unified context
```

### Sales-support → sources on reply
```
/sales-support question
    → build context (knowledge + code + reviews + FAQ)
    → OpenAI answer (no inline sources)
    → saveSalesSupportContext() + linkMessageToContext()
    → Discord message with hint

User replies "πηγές" to bot message
    → getContextByMessageId()
    → return stored sourceBlock
```

---

## Optional / not yet configured

- **GitHub webhook** for instant commit review (needs public URL + `GITHUB_WEBHOOK_SECRET`)
- **`KNOWLEDGE_REPO_FETCH=true`** — refresh wiki branch before each load
- **`npm run review:backfill`** — mentioned as possible manual backfill script (not added unless requested)

---

## Restart checklist

After any `.env` or code change:

```bash
cd ~/Projects/discord-linear-bot
npm start
```

On ready, logs should show something like:
- `Auto commit review: poll on`
- Slash commands registered: `/n8n-linear`, `/deploy`, `/sales-support`

---

## Related repos (local)

| Repo | Path / remote | Role |
|------|---------------|------|
| **discord-linear-bot** | `~/Projects/discord-linear-bot` | This bridge |
| **EmblemTameiaki** | `semantic-software/EmblemTameiaki` | App code, commits, PRs |
| **EmblemTameiaki-Knowledge** | `semantic-software/EmblemTameiaki-Knowledge` | Product docs (`restructure/wiki-structure`) |

---

*Generated from the Cursor agent session covering Discord bridge, commit review, auto-review, knowledge wiki integration, unified Emblem context, all-branches code activity, and reply-to-sources for `/sales-support`.*
