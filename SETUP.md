# Discord → Linear Bot

Discord DM bridge + n8n workflow for natural-language Linear commands.

## Project layout

| File | Purpose |
|------|---------|
| `discord-bridge.js` | Runs locally; forwards DMs to n8n |
| `discord-linear-bot.json` | n8n workflow backup / re-import |
| `.env` | Your secrets (copy from `.env.example`) |

## What's already done

- n8n workflow **imported** as `Discord → Linear Bot` on [n8n.techflowlabs.gr](https://n8n.techflowlabs.gr)
- Bridge script created in this repo (`DM_ONLY=true` by default)
- `discord.js` installed

## What still needs finishing in n8n

Open workflow `Discord → Linear Bot` and fix these before activating:

### 1. Reconnect the AI chain (broken after import)

These connections are missing:

```
Extract Message → AI: Parse Command → Parse AI Response
```

In the editor, drag wires between those three nodes.

### 2. Fix the AI node

The current `AI: Parse Command` node (`lmChatAnthropic`) is incomplete. Replace it with an **Anthropic** node:

- Resource: **Text**
- Operation: **Message a Model**
- Model: `claude-sonnet-4-6`
- System message: paste the Linear parser prompt from `discord-linear-bot.json`
- User message: `={{ $('Extract Message').first().json.userMessage }}`
- Connect your **Anthropic API** credential
- Enable **Simplify Output** and **Include Merged Response**

Wire: `Extract Message` → `Anthropic` → `Parse AI Response`

### 3. Linear: Get Team Members node

The live workflow is missing the GraphQL body. Set:

**Query:**
```graphql
query GetTeamMembers($teamId: String!) {
  team(id: $teamId) {
    members {
      nodes {
        id
        name
        email
      }
    }
  }
}
```

**Variables:** `={{ JSON.stringify({ teamId: $vars.LINEAR_TEAM_ID }) }}`

### 4. Linear credentials on all HTTP nodes

Only **Linear: Create Issue** has a credential attached. Add the same **HTTP Header Auth** credential (`Authorization: Bearer <key>`) to:

- Linear: Search Issues
- Linear: Get States
- Linear: Get Team Members
- Linear: Update Status
- Linear: Assign Issue

### 5. Workflow variables

In workflow settings → **Variables**, add:

| Variable | Value |
|----------|-------|
| `LINEAR_TEAM_ID` | Your Linear team UUID |
| `DISCORD_BOT_TOKEN` | Same bot token as `DISCORD_TOKEN` |

### 6. Activate and copy webhook URL

1. Toggle workflow **Active**
2. Copy production webhook URL: `https://n8n.techflowlabs.gr/webhook/discord-linear-bot`
3. Put it in `.env` as `N8N_WEBHOOK`

## Run the bridge (local Mac)

```bash
cd ~/Projects/discord-linear-bot
cp .env.example .env
# edit .env with your values

npm start
```

Or one-shot:

```bash
DISCORD_TOKEN=... BOT_USER_ID=... N8N_WEBHOOK=https://n8n.techflowlabs.gr/webhook/discord-linear-bot npm start
```

Keep the terminal open while testing.

## Test via DM

1. In Discord, find your bot → **Message**
2. Send: `create issue Test from Discord bot`
3. Bot should reply in the DM with a Linear issue link

## Discord bot checklist

In [Discord Developer Portal](https://discord.com/developers/applications):

- **Message Content Intent** enabled
- Bot token copied → `DISCORD_TOKEN` and n8n `DISCORD_BOT_TOKEN`
- Bot user ID copied → `BOT_USER_ID`

No server invite needed for DM-only testing — just open a DM with the bot.

## Commands to try

| Message | Action |
|---------|--------|
| `create issue Fix the login bug high priority` | Create issue |
| `update ENG-123 to In Progress` | Update status |
| `assign ENG-456 to John` | Assign |
| `search for open bugs` | Search |
| `add comment to ENG-789: needs design review` | Add comment |
