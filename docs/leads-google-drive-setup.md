# /leads — Google Drive setup

The bot lists Excel files in a shared Google Drive folder (**read-only** — it never creates, edits, moves, or deletes anything) and uses AI to pick the best file for the employee's question.

Default folder: `1ro5kXfGnc3VZz0Mg41DqyEN49CoQc0nF`

## Is the folder link enough?

**Partially.** The folder URL gives us the folder ID (already configured as default). You still need:

1. A **Google Cloud service account** with Drive API enabled
2. The leads folder **shared with the service account email** as **Viewer**

Without step 2, the API returns an empty list or permission denied.

---

## Google Cloud setup

### 1. Enable API

In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Library**:

- Enable **Google Drive API**

### 2. Create service account

**IAM & Admin → Service Accounts → Create**

- Download **JSON key** (Keys → Add key → JSON)

### 3. Share access with the service account

**Check where the folder lives** (left sidebar in Google Drive):

#### A) Folder is under **My Drive** (personal)

1. Open the folder
2. **Share** → add `discord-leads-bot@emblem-bot.iam.gserviceaccount.com`
3. Role: **Viewer**
4. Confirm the email appears in **Manage access**

#### B) Folder is inside a **Shared drive** (most common issue)

Sharing a single folder is **not enough** for service accounts.

1. In the left sidebar, click the **Shared drive** name (parent of your folder)
2. Click the drive name again → **Manage members**
3. **Add member** → `discord-leads-bot@emblem-bot.iam.gserviceaccount.com`
4. Role: **Viewer** (read-only)
5. Save

Without step 3–4, the API returns **“File not found”** and **0 files** — even if you shared the subfolder.

#### C) Quick workaround

Create `Leads-bot` in **My Drive**, copy the Excel files there, share **that folder** with the service account as Viewer, and set `LEADS_DRIVE_FOLDER_ID` to the new folder ID.

---

## Discord bot `.env`

Pick **one** credential method:

```bash
# Option A — path to downloaded JSON key (recommended)
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/path/to/service-account.json

# Option B — inline (if you prefer not to use a file)
# GOOGLE_SERVICE_ACCOUNT_EMAIL=leads-bot@project.iam.gserviceaccount.com
# GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Folder (default is already set — override only if it changes)
LEADS_DRIVE_FOLDER_ID=1ro5kXfGnc3VZz0Mg41DqyEN49CoQc0nF

# Search subfolders too (default: true)
# LEADS_DRIVE_RECURSIVE=true
```

Restart the bridge after adding credentials.

---

## How it works

```
/leads question:Ποιο αρχείο έχει leads για Emblem Tameiaki;
    ↓
List all .xlsx / .xls / Google Sheets in folder (read-only, recursive)
    ↓
GPT picks best filename match from the catalog
    ↓
Discord reply with file name + Google Drive link
```

**Optional fallback:** If `LEADS_N8N_WEBHOOK` is set and Drive fails, the bot can fall back to n8n.

---

## Test

```
/leads question:Ποιο αρχείο έχει τα leads για Emblem Tameiaki;
```

---

## Checklist

1. [ ] Google Drive API enabled
2. [ ] Service account JSON downloaded
3. [ ] Folder shared with `client_email` as Viewer
4. [ ] `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` in `.env`
5. [ ] Bridge restarted
6. [ ] `/leads` tested in Discord
