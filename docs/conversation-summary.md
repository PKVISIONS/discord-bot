# Discord Bot — Full Story of What We Built

From late June to mid-July 2026, this project grew from a simple “send a Discord message → create a Linear issue” setup into a full internal AI assistant for Emblem Tameiaki.

This document tells that story in plain language: what was asked for, what was built, why it was done that way, and what still needs attention.

Everything lives on your Mac at:

`~/Projects/discord-linear-bot`

---

## How it started

The original goal was straightforward. You wanted a Discord bot that could talk to Linear through n8n — create issues, change status, assign people, search, and add comments. At first, only private messages were needed so you could test safely.

We set up the Discord bridge (`discord-bridge.js`), connected it to an n8n workflow, fixed a broken Anthropic node in n8n, and put the credentials in a `.env` file. The Linear team was ENG.

The idea was simple: Discord can’t talk to Linear by itself, so the bot forwards your message to n8n, n8n uses AI to understand what you meant, and then it calls Linear.

Early friction was mostly setup:

- The bot was hard to find in Discord at first
- Environment variables were missing when starting with `npm start`
- Some n8n replies came back empty
- Issue links like ENG-11 showed as plain text instead of clickable links
- Only one Linear teammate appeared for assignment until that was fixed on the Linear side

Once DMs worked, you asked for a slash command in the server: `/n8n-linear`. That became the main way to talk to Linear from Discord.

---

## Adding GitHub

Next came a bigger ask: the bot should not only read Linear issues — it should also look at GitHub and make code changes based on what Discord said.

You wanted:

- Clickable Linear issue links
- Access to the TechFlow-Labs GitHub org
- Auth with a personal access token (PAT), not a GitHub App, because the App setup felt too heavy
- A “plan first, then go” flow so the bot proposes changes before applying them

That became the plan memory system. You could say something like “plan fix ENG-10 in wed-main-mvp repo”, review the plan, then say “go”. The bot would create a branch, apply edits, and open a PR. Plans could also be stored as Linear documents attached to the issue.

A lot of debugging happened here: GitHub execute was off, n8n nodes ran in the wrong order, PATs lacked permissions (403 errors), and “go” sometimes got stuck. Those were fixed by enabling flags, repairing the workflow chain, and rotating to a stronger PAT.

---

## Automatic commit reviews

You then wanted the bot to review every push automatically. When someone pushes code, the bot should summarize possible bugs and problems, post that summary in a Discord channel called Commit-Summary, and keep that data somewhere reusable.

We built a webhook server for that. On push, the AI reviews the diff, posts to Discord, and stores the review locally so other commands (especially sales support) can reuse it later.

You also asked for a way to pick a repo, see its branches, and request a summary of the latest commit on a specific branch. Discord’s 2000-character message limit kept breaking long branch lists, so responses were split or shortened where needed.

---

## Sales support

This was a major shift. You wanted a separate command where the bot behaves like customer support and a salesperson — helping employees demo Emblem Tameiaki and answer client questions.

Requirements were clear:

- Answers in Greek
- Sound human, credible, and natural — not robotic or repetitive
- Client-facing text should be friendly, not technical
- Don’t dump markdown references into the answer the employee would read to a client
- Sources should exist only for the employee, and only when asked

That became `/sales-support`.

Around the same time we switched from Anthropic to OpenAI everywhere. The FAQ file was pulled in, and later the whole `EmblemTameiaki-Knowledge` repo became the knowledge base. Docs were indexed into a vector store so the bot could search by meaning, not just keywords.

You refined the source behavior over a few rounds:

1. Put sources in the employee-only part of the answer
2. Then: show sources only if asked
3. Then: allow a plain reply to a bot message (“where did you get this?”) without typing a slash command

That reply-to-message flow is still how sources work.

There were quality problems too. Sometimes the bot cited the wrong docs, or answered generically even when the right markdown existed. That led to better indexing, an AI-focused knowledge branch based on `wiki-structure`, and syncing so the knowledge branch didn’t fall behind.

---

## Growing the knowledge base

You asked how to make answers as factual as possible and how to stop losing bug/fix knowledge from Discord chats.

We built:

- A vector index of knowledge documents
- Manual reindex (`npm run kb:sync`)
- Automatic reindex when docs change — polling plus GitHub webhooks
- A way to capture useful Discord bug/fix discussions into the knowledge store

Later, Cardlink vendor files (PDFs and related assets) were added as-is, without converting them to markdown. The indexer extracts text from those files. A zip-download approach was tried and then reverted because you didn’t want that path.

The reason for auto-reindex was practical: every time a new markdown doc appeared, someone had to remember to reindex. Now a new commit under `docs/` triggers it.

---

## Developer help: `/dev`

You wanted a coding-focused slash command for implementation ideas, feature planning, and technical questions. That became `/dev`.

Discord’s input limit was a problem again, so longer questions use a modal. The answer is also attached as a markdown file so nothing gets cut off in the chat.

---

## App status and QA escalation

You shared a design doc for an auto-escalation bot aimed at testers and non-developers. We split that into two steps.

First we built `/app-status`: ask where the app is at, what’s new, what’s broken, and get an answer from GitHub + knowledge + commit reviews.

The escalation channel piece was implemented, then reverted when you said it should wait as a second step. It was brought back later as that second step.

We also put the bot on another Discord server. Slash commands don’t appear until they are registered for that guild (`npm run slash:refresh`), which caused some confusion when the bot was invited but commands weren’t visible yet.

---

## Help, scope, and housecleaning

To make the bot usable for new people, we added `/help` — in Greek — with examples for every slash command. It updates as new commands appear.

You then narrowed the bot’s world: only EmblemTameiaki. Other repos were removed so the agent wouldn’t get distracted or ask about the wrong codebase.

The project was also pushed to `https://github.com/PKVISIONS/discord-bot`.

---

## Hub threads

Once more employees started using the bot in the same channels, messages got messy and context got lost. You wanted a middle ground: not one giant shared thread for everyone, and not fully private DMs either.

The solution was hub threads. When someone runs a command, the bot opens a session thread (with date and time in the name). That keeps conversations organized without locking knowledge away from the team.

Threads older than 24 hours are deleted automatically. That originally failed because the bot lacked Manage Threads permission. After you granted it, cleanup worked.

Around this time we also improved Linear issue creation:

- The bot reads the issue carefully
- It classifies it as bug, feature, or task
- That classification goes in Linear’s type field (not a label)
- Issues are always written in English, even if the employee wrote in Greek

Before answering, the bot also pulls the latest knowledge/code so answers don’t go stale.

---

## Leads from Google Drive

Employees needed a way to find lead Excels without digging through Drive manually. That became `/leads`.

At first it matched by filename and folder (“which file has Emblem Tameiaki leads?”). Later you asked for content search: paste a phone number (or email / AFM / keyword) and scan every Excel for a match.

That required a Google service account, Drive API access, and an Excel parser. Shared Drive permissions were painful — sharing a folder wasn’t always enough — so the practical workaround was copying files into a My Drive folder the service account can actually see.

There was also a parser bug: 9-digit AFM numbers were treated as phone numbers. That was fixed by checking AFM first.

---

## Morning codebase briefs

You shared a sample Word brief and asked for the same kind of document every morning at 9:00 in `#tameiaki-ai-briefs`.

The brief is meant for developers: what happened recently, what needs attention today, and what to tackle first. It ships as a `.docx`.

Over several rounds you refined it:

- Keep it as one Word file, not two separate briefs
- Include all commits from the lookback period, not just a vague summary
- Add stale branches (no commit for a week) and list every one of them in the document
- Make commits compact: title, author, date
- Put those commits in a real table inside the Word doc

An early bug made the brief show mostly `[QA]` commits. That happened because GitHub search favored main/develop. We changed it to walk active branches and collect commits from all of them.

We briefly tried HTML for the commit table, then a separate HTML attachment. Your final ask was clear: keep the brief as a doc, and put the table inside the Word file.

---

## Keeping the bot online

Running `npm start` by hand got old. You wanted the bot always online unless the Mac restarts or sleeps.

We set up PM2 to keep the process alive and restart it on crashes, plus macOS LaunchAgent / healthcheck scripts so it comes back after reboot or wake. Discord gateway reconnects were also improved, because short disconnects were making the bot flicker offline.

Important detail: this still runs locally on your Mac. PM2 is not a cloud host — it’s a process manager on your machine. Config is in `ecosystem.config.cjs`.

---

## What the bot can do today

| Command / feature | What it’s for |
|---|---|
| `/n8n-linear` | Create and manage Linear issues |
| `/sales-support` | Greek sales & customer support answers from knowledge + code |
| `/dev` | Coding ideas and implementation plans (with `.md` attachment) |
| `/app-status` | What’s going on with the app right now |
| `/leads` | Find lead Excels by name, or search inside them by phone/email/AFM |
| `/help` | Greek examples for every command |
| Auto commit review | On push, posts a review to Commit-Summary |
| Daily brief | 9:00 AM Word brief in tameiaki-ai-briefs |
| Thread cleanup | Deletes hub threads older than 24 hours |
| Knowledge reindex | Keeps new markdown docs searchable automatically |
| Reply for sources | Reply to a bot answer and ask where it came from |

---

## Why things were built this way

A few choices shaped the whole system:

- **OpenAI instead of Anthropic** — you asked for that switch, so it was applied across the board.
- **PAT instead of GitHub App** — simpler for your setup, even if Apps are “more proper” long term.
- **Vector search for knowledge** — with lots of docs, meaning-based search beats filename guessing.
- **Hub threads** — keeps employee chats tidy without hiding them completely.
- **Service account for Drive** — employees don’t need to log into Google through the bot.
- **Word briefs** — matches how your team already reads day plans.
- **Greek for people, English for Linear** — employees talk to clients in Greek; engineering tickets stay in English.
- **EmblemTameiaki only** — one product focus, fewer wrong answers.

---

## Still open / deferred

A few things were started and then paused, or need a follow-up:

- Full QA escalation flow from the original design doc (partially done, then stepped back)
- Zip-based knowledge import (tried, then reverted)
- Occasional PM2 permission issues on the Mac (`~/.pm2`)
- Cleaner Google Shared Drive access for the leads service account (current workaround: My Drive copies)

---

## Security reminder

During this work, real credentials were pasted into chat (Discord token, Linear key, GitHub PATs, n8n key, Google service account). If this summary or the chat history is shared widely, those secrets should be rotated.

---

## Bottom line

What began as a personal Linear DM bot is now an always-on Discord assistant that:

- manages Linear issues
- reviews GitHub commits
- answers sales and support questions from a living knowledge base
- helps with development questions
- finds leads in Google Drive Excels
- publishes a daily developer brief
- keeps its own session threads clean

All of it runs from your local project folder, kept alive by PM2.
