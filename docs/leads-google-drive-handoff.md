# Google Drive `/leads` — completed work handoff

Status: **Bot-side implementation done.** Drive access blocked until service account is added to the Shared drive (or folder shared correctly from My Drive).

---

## Goal

Employees use Discord `/leads` to ask which Excel file on Google Drive contains leads for a company/product (e.g. “Ποιο αρχείο έχει leads για Emblem Tameiaki;”). The bot returns the best-matching file name + Google Drive link.

**Constraints:** Read-only — never create, edit, move, or delete anything on Drive.

---

## Architecture (implemented)

```
/leads question:...
    ↓
lib/leads-flow.js
    ↓
lib/leads-drive.js     → Google Drive API (service account, drive.readonly)
    ↓
lib/leads-matcher.js   → OpenAI picks best file from catalog (filenames + paths)
    ↓
Discord reply with link

Optional fallback: LEADS_N8N_WEBHOOK (n8n) if Drive fails and webhook is set
```

Originally planned via n8n only; **implemented directly in the bot** so n8n is optional.

---

## Files added / changed

| File | Purpose |
|------|---------|
| `lib/leads-drive.js` | Service account auth, recursive folder listing, spreadsheet mime filter, `verifyFolderAccess()` |
| `lib/leads-matcher.js` | AI match question → best file (JSON: fileId, confidence, reason) |
| `lib/leads-flow.js` | Slash handler; Drive primary, n8n fallback |
| `lib/slash-commands.js` | `/leads` command registration + Greek help |
| `lib/assistant-hub-session.js` | Hub thread summary for `leads` |
| `discord-bridge.js` | Wires `/leads` interaction handler |
| `docs/leads-google-drive-setup.md` | Setup guide (credentials, sharing, Shared drive notes) |
| `scripts/test-leads-drive.js` | `npm run leads:test` — verify SA can list files |
| `.env.example` | `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`, `LEADS_DRIVE_FOLDER_ID` |
| `package.json` | Added `googleapis` dependency; `leads:test` script |

---

## Environment variables

```bash
# Required for Drive path
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/path/to/service-account.json

# Target folder (user's folder)
LEADS_DRIVE_FOLDER_ID=1yrV9WRjZ1vUvcZx7jb29N-0AiNTievsU

# Optional
# LEADS_DRIVE_RECURSIVE=true          # default: search subfolders
# LEADS_MATCH_MODEL=gpt-4o-mini
# LEADS_N8N_WEBHOOK=...               # fallback only

# Also requires existing:
OPENAI_API_KEY=...
DISCORD_TOKEN=...
```

**User’s service account:**
- Email: `discord-leads-bot@emblem-bot.iam.gserviceaccount.com`
- JSON path (on user machine): `/Users/konstantinospeltekis/Documents/google-keys/emblem-bot-a6ebc786da47.json`

**Folder URLs discussed:**
- Original: `1ro5kXfGnc3VZz0Mg41DqyEN49CoQc0nF`
- User’s editor folder: `1yrV9WRjZ1vUvcZx7jb29N-0AiNTievsU` ← configured in `.env`

---

## Google Cloud setup (done by user)

1. Google Cloud project: `emblem-bot`
2. **Google Drive API** enabled
3. Service account created + JSON key downloaded
4. Share folder with SA — **user reported “shared” but API still returns 0 files**

---

## Blocking issue (unresolved)

API test from bot machine:

```
sharedWithMe: 0
files.get(folderId): File not found
```

**Root cause:** Folder is likely inside a **Shared drive**. Sharing only the subfolder does **not** grant service accounts access. The SA must be added as a **member of the Shared drive** (Viewer), not only via folder Share.

**Fix for ops:**
1. Google Drive → click **Shared drive** name (parent)
2. **Manage members** → add `discord-leads-bot@emblem-bot.iam.gserviceaccount.com` as **Viewer**
3. Run `npm run leads:test` — should list spreadsheets
4. Restart bridge; test `/leads question:...`

**Workaround:** Copy Excel files to a folder in **My Drive**, share that folder with SA as Viewer, update `LEADS_DRIVE_FOLDER_ID`.

---

## Discord usage

```
/leads question:Ποιο αρχείο έχει τα leads για Emblem Tameiaki;
/leads question:Πού είναι το excel με leads για SoftPOS;
```

Posts in hub channel thread (same pattern as other slash commands) when used from `#tameiaki-ai-assistant`.

---

## n8n (optional, not required)

If `LEADS_N8N_WEBHOOK` is set, bot falls back to n8n on Drive errors.

**Webhook payload:**
```json
{
  "source": "slash",
  "command": "leads",
  "question": "...",
  "channel_id": "...",
  "user": { "id": "...", "username": "..." }
}
```

**Expected response:**
```json
{
  "message": "...",
  "fileName": "....xlsx",
  "fileUrl": "https://drive.google.com/file/d/.../view"
}
```

See `docs/leads-google-drive-setup.md` for full Google credential checklist.

---

## Verification commands

```bash
npm run leads:test
# Expect: Spreadsheets found: N (N > 0)

npm start
# Then in Discord: /leads question:...
```

---

## What remains

- [ ] Add SA to **Shared drive members** (or My Drive workaround)
- [ ] Confirm `npm run leads:test` lists files
- [ ] Restart bridge after `.env` is correct
- [ ] End-to-end `/leads` test in Discord
- [ ] (Optional) Remove `LEADS_N8N_WEBHOOK` if Drive path is sufficient

---

## Out of scope (this task)

- Reading Excel cell contents (only filenames/metadata for matching)
- Writing to Drive
- n8n workflow build (bot handles Drive directly)
- Daily codebase brief (`/leads` is separate feature)
