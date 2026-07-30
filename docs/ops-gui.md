# Ops GUI — error handler trial

Small web UI for non-devs to see Discord bot / n8n automation failures in plain language and **Retry** or **Dismiss** them — without opening n8n.

Production for this bot is **Railway**. The GUI is served by the same HTTP server as GitHub webhooks.

## Open it (Railway)

1. Deploy/restart the service so this code is live.
2. Open:

```text
https://YOUR-RAILWAY-DOMAIN/ops/
```

Use the same public base you already use for webhooks (`WEBHOOK_PUBLIC_URL`), or Railway’s public domain — e.g. if GitHub hits `https://discord-bot-production-xxxx.up.railway.app/github/webhook`, the GUI is:

```text
https://discord-bot-production-xxxx.up.railway.app/ops/
```

On boot the bridge logs the exact URL (`[ops-gui] open …`).

### Token (recommended on Railway)

In Railway Variables set:

```env
OPS_GUI_TOKEN=a-long-random-string
```

Then open:

```text
https://YOUR-RAILWAY-DOMAIN/ops/?token=a-long-random-string
```

Without a token, `/ops` is reachable by anyone who knows the public URL.

## Local (optional)

```text
http://localhost:3847/ops/
```

(or whatever `PORT` / `WEBHOOK_PORT` you use)

## What it captures

| Failure | Retryable |
| --- | --- |
| n8n webhook unreachable / bad HTTP | Yes (re-posts the saved payload) |
| n8n empty reply | Yes |
| Plan execute failed | No |
| Deploy trigger failed | No |
| Slash/DM handler crash | No |

Use **Add sample error** in the UI to try the flow without a real outage.

## Test from Discord

With **Developer** or **Admin** role:

```text
/ops-test
```

That intentionally fails the n8n call path, posts a plain-language Discord reply with the `/ops` link, and logs a card on the Ops page.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPS_GUI_ENABLED` | on | Set `false` to disable |
| `OPS_GUI_TOKEN` | empty | **Set this on Railway** |
| `PORT` | (Railway injects) | Preferred listen port in production |
| `WEBHOOK_PORT` | `3847` | Local fallback if `PORT` unset |
| `WEBHOOK_PUBLIC_URL` | Railway domain / localhost | Public base used in boot logs |

Errors are stored in `data/ops-errors.json` on the running container volume (ephemeral on Railway unless you attach a volume).
