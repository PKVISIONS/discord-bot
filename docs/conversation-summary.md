# Conversation Summary — Discord → Linear Bot

This document captures the questions, fixes, architecture decisions, and references from the development session on the **discord-linear-bot** project (`~/Projects/discord-linear-bot`).

---

## Project overview

| Piece | Role |
|-------|------|
| `discord-bridge.js` | Local Discord bridge (`/n8n-linear`, DMs, plan memory, **`go` execution**) |
| n8n workflow **Discord → Linear Bot** | ID `fxxutl0HMJbv3p4G` on `https://n8n.techflowlabs.gr` |
| `scripts/patch-workflow.js` | Patches Linear assign/search flows |
| `scripts/patch-bridge-flow.js` | Patches shortcuts, plan flow, GitHub list, deploys to n8n |
| `lib/github-plan-executor.js` | AI edits → branch → commit → PR (runs on **`go`**) |
| `lib/github-plan-issue.js` | GitHub tracking issues for plans |
| `lib/plan-document.js` | Markdown formatter for Linear plan documents |
| `pending-plans.js` | In-memory plan store (`go` / `cancel` / `plan` status) |

**Org:** `TechFlow-Labs` (`GITHUB_ORG`)  
**Linear workspace:** `techflowlabs` (`LINEAR_WORKSPACE`)  
**Linear team ENG** (team ID used in GraphQL: `a28a98ff-3d04-4ab4-bcb9-cd03f165ac2a`)

---

## Questions asked & answers

### 1. Can you see n8n executions yourself?

**Yes.** Via n8n REST API with `N8N_API_KEY` and workflow ID `fxxutl0HMJbv3p4G`. Executions **1453** and **1454** were inspected directly.

**Findings:**

| Execution | Command | Problem |
|-----------|---------|---------|
| **1453** | `Give me a summary of ENG-10` | Summary path worked, but **AI ran in parallel** with shortcuts; search branch won `Respond to Webhook` first → wrong reply |
| **1454** | `Can you see the ENG-10 issue?` | AI returned `search_issues` without `query` → Linear GraphQL 400 → empty Discord body |

**Root cause (1453):** `Bridge Execute?` false branch connected to **both** `AI: Parse Command` and `Command Shortcuts` in parallel. AI finished first and responded to the webhook before the summary path completed.

---

### 2. What remains of the GitHub part?

**Before this session (stubs only):**

- `list repos` — working via n8n
- `plan …` — draft plan stored in bridge memory
- `go` — stub only (“next build step”)

**Built during session:**

- Full **AI-driven execute** in bridge (`lib/github-plan-executor.js`)
- Two-pass AI (file selection → search/replace edits)
- Branch → commit → PR
- Later: **Linear plan documents**, **GitHub tracking issues**, permission hardening

---

### 3. AI-driven edits before PR

**Decision:** Run heavy work in the **bridge** (not n8n) to avoid webhook timeouts.

**Flow on `go`:**

1. Validate repo
2. Ensure GitHub tracking issue (if possible)
3. Scan repo file tree
4. AI pass 1 — pick files to read (max 4)
5. Read files from GitHub
6. AI pass 2 — generate **search/replace** patches (max 3 files)
7. Create branch → commit files → open PR with `Fixes #N` when issue exists

**New files:**

- `lib/github-api.js`
- `lib/openai.js`
- `lib/github-plan-executor.js`

**Env required for execute:**

```bash
GITHUB_TOKEN=...
OPENAI_API_KEY=...
# optional:
OPENAI_MODEL=gpt-4o
```

Bridge startup shows: `GitHub execute: on` or `off (need OPENAI_API_KEY)` etc.

---

### 4. GitHub execute is off

**Cause:** `OPENAI_API_KEY` was in the editor but **not saved** to `.env` on disk.

**Fix:** Save `.env`, restart `npm start`. Startup log was improved to list which keys are missing.

---

### 5. Repo name format for `plan` commands

Use the **short repo name only**, not a URL or `org/repo`:

```
plan fix ENG-10 in wed-main-mvp
```

`GITHUB_ORG` (`TechFlow-Labs`) is prepended automatically → `TechFlow-Labs/wed-main-mvp`.

**Does not work (today):**

- `in https://github.com/TechFlow-Labs/repo`
- `in TechFlow-Labs/repo`
- `in repo-name` not at the **end** of the message

**Optional trailing word `repo` is supported:**

```
plan fix ENG-10 in wed-main-mvp repo   ✅ → repo = wed-main-mvp
```

---

### 6. `Build Pending Plan` — Parse AI Response error

**Error:**

```
Cannot assign to read only property 'name' of object
'Error: Node Parse AI Response hasn't been executed'
```

**Cause:** Shortcut `plan …` never runs AI, but `Build Pending Plan` referenced `$('Parse AI Response')`.

**Fix:** Use `Command Shortcuts` when `action === 'plan_github'`, only fall back to `Parse AI Response` on the AI path. Same fix for `Linear: Resolve Issue (Plan)` variables.

---

### 7. Stuck on “Generating code edits with AI…”

**Cause:** Old flow sent up to 8 large files and asked for **full file rewrites** (slow, no timeout, no heartbeat).

**Fixes:**

- Max 4 files read, 3 edited
- **Patch-style** edits (`replacements` with `old`/`new` snippets)
- 5-minute API timeout
- Heartbeat updates in Discord (`Still generating edits… (20s)`)
- Auto-fetch missing files; support **new file** creation (`old: ""`)

---

### 8. AI tried to edit unknown file (`TranscriptionScreen.tsx`)

**Cause:** AI **hallucinated** a path. `wed-main-mvp` has `components/pages/NotesScreen.tsx` etc., but **no** `TranscriptionScreen.tsx`.

**Fixes:**

- Resolve/fetch paths from repo tree; allow new files via empty `old`
- Validate paths against tree; better file scoring from issue keywords
- Clearer errors with “did you mean …?” suggestions

**Note:** Wrong repo for ENG-10 may still produce poor edits — user should plan with the correct repo.

---

### 9. Plan doc inside Linear (not GitHub)

**User request:** Store plan as a document **in Linear**, linked on the issue.

**Implementation:**

1. `documentCreate` GraphQL mutation → Linear document on issue
2. Discord shows `Plan doc: https://linear.app/techflowlabs/document/...`
3. Document appears under issue **Resources**

**Removed:** GitHub gist / `docs/linear-plans/*.md` commits (gist failed with 403 — no gist scope).

**Example doc URL:**

`https://linear.app/techflowlabs/document/ai-plan-eng-10-50083b099d21`

---

### 10. GitHub issues before PR

**User request:** GitHub tracking issues **before** the agent opens a PR.

**Implementation (at `plan` time in n8n):**

1. After Linear document → `GitHub: Create Plan Issue`
2. Title: `[ENG-10] {summary}`
3. Body: Linear link, plan doc link, steps, description
4. Reuses existing open issue with `[ENG-10]` in title if found
5. Stored on `pendingPlan`: `githubIssueNumber`, `githubIssueUrl`

**On `go`:** PR body includes `Fixes #N`; bridge re-ensures issue exists.

**Example:** `https://github.com/TechFlow-Labs/wed-main-mvp/issues/9`

---

### 11. GitHub API 403 on `go`

**Error:**

```
❌ GitHub API 403: Resource not accessible by personal access token
```

**Context:** Repo `web-video-call-transcription` — token could **read** repo and **search** issues, but **createIssue** returned 403.

**Cause:** Fine-grained PAT missing **Issues: Read and write** on that specific repo (repo must be explicitly added to token).

**Fix (code):** `ensureGitHubIssue` returns `null` on 403 instead of aborting; `go` continues with a warning.

**Fix (token):** GitHub → Fine-grained PAT → add each target repo with:

| Permission | Access |
|------------|--------|
| Issues | Read and write |
| Contents | Read and write |
| Pull requests | Read and write |
| Metadata | Read |

---

## Fixes deployed (chronological)

1. **Parallel AI + shortcuts race** — `Bridge Execute?` false → only `Command Shortcuts`
2. **Extract Message** — unwrap nested webhook `body`
3. **Search issues fallback** — `query \|\| issue_id \|\| userMessage`
4. **Summarize shortcuts** — `summary of ENG-10`, `can you see ENG-10?`
5. **Bridge-local execute** — `go` no longer forwarded to n8n stub
6. **OpenAI model** — default `gpt-4o` (set `OPENAI_MODEL` in `.env`)
7. **AI edit performance** — patches, timeouts, heartbeats
8. **Plan shortcut path** — no `Parse AI Response` on shortcut plans
9. **Linear plan documents** — `documentCreate` on issue
10. **GitHub plan issues** — created at plan time, linked on PR
11. **403 resilience** — skip GitHub issue creation if token lacks permission

---

## Current `plan` → `go` flow

```
Discord: plan fix ENG-10 in my-repo
    ↓
n8n: Command Shortcuts → Linear resolve issue → Build Pending Plan
    ↓
n8n: Plan Format Document (markdown)
    ↓
n8n: Linear Create Plan Document  →  linear.app/.../document/...
    ↓
n8n: GitHub Create Plan Issue      →  github.com/.../issues/N
    ↓
n8n: Plan Finalize Message → Discord (all links + steps)
    ↓
Bridge: stores pendingPlan in memory

Discord: go
    ↓
Bridge: github-plan-executor
    - ensure GitHub issue (or skip on 403)
    - AI file pick + AI patches
    - branch → commits → PR (Fixes #N)
```

---

## Commands reference

| Command | Where it runs |
|---------|----------------|
| `list repos` | n8n |
| `plan fix ENG-10 in repo-name` | n8n |
| `summary of ENG-10` / `can you see ENG-10?` | n8n (shortcut) |
| Linear ops (create, assign, search, …) | n8n |
| `go` | **bridge** (AI + GitHub) |
| `cancel` | bridge (local) |
| `plan` / `status` | bridge (show pending plan) |

**Slash:** `/n8n-linear command: <text>`  
**DM_ONLY=true** (default): plain messages only in DMs; use slash in server channels.

---

## Environment variables

```bash
DISCORD_TOKEN=
BOT_USER_ID=
N8N_WEBHOOK=https://n8n.techflowlabs.gr/webhook/discord-linear-bot
N8N_API_KEY=                    # n8n API + execution inspection
DISCORD_GUILD_ID=
LINEAR_WORKSPACE=techflowlabs
GITHUB_ORG=TechFlow-Labs
GITHUB_TOKEN=                     # Issues + Contents + PR write per repo
OPENAI_API_KEY=                # required for go + commit reviews
OPENAI_MODEL=gpt-4o             # optional
DM_ONLY=true
# PLAN_TTL_MINUTES=30
```

---

## Key file paths (codebase)

```
discord-linear-bot/
├── discord-bridge.js
├── pending-plans.js
├── lib/
│   ├── github-api.js
│   ├── openai.js
│   ├── github-plan-executor.js
│   ├── github-plan-issue.js
│   └── plan-document.js
├── scripts/
│   ├── patch-workflow.js
│   └── patch-bridge-flow.js
├── config/discord-linear-users.json
└── docs/conversation-summary.md   ← this file
```

---

## n8n workflow nodes (plan path)

```
Extract Message → Bridge Execute? → Command Shortcuts → …
Is Plan GitHub? → Linear: Resolve Issue (Plan) → Build Pending Plan
  → Plan: Format Document
  → Linear: Create Plan Document
  → GitHub: Create Plan Issue
  → Plan: Finalize Message
  → Slash via bridge? → Respond to Webhook
```

**Deprecated / removed nodes:** `GitHub: Create Plan Gist`, `GitHub: Save Plan Doc`, `Linear: Attach Plan Doc` (external link attachment).

---

## External references

| Resource | URL |
|----------|-----|
| n8n instance | https://n8n.techflowlabs.gr |
| n8n webhook | https://n8n.techflowlabs.gr/webhook/discord-linear-bot |
| Linear ENG-10 | https://linear.app/techflowlabs/issue/ENG-10/add-generated-references-panel-to-workspace-transcription-view |
| OpenAI API keys | https://platform.openai.com/api-keys |
| Linear `documentCreate` | https://api.linear.app/graphql |
| GitHub fine-grained PATs | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens |
| GitHub create issue API | https://docs.github.com/rest/issues/issues#create-an-issue |

---

## Known limitations / follow-ups

- Plan store is **in-memory** — lost on bridge restart (30 min TTL)
- Re-planning same issue creates **new Linear documents** (no upsert yet)
- AI may pick wrong files or hallucinate paths on unfamiliar repos
- Fine-grained PAT must list **each repo** explicitly
- `go` execute is **not** in n8n — requires bridge running locally with keys
- ENG-10 may belong in a different repo than `wed-main-mvp` (transcription work)

---

## Deploy commands

```bash
# Patch live n8n workflow
npm run patch:n8n
# or
node scripts/patch-workflow.js && node scripts/patch-bridge-flow.js

# Run bridge
npm start
```

---

*Generated from the Cursor agent session covering Discord → Linear → GitHub plan/execute development.*
