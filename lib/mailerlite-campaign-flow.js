/**
 * MailerLite campaign editing from Discord chat (passive listener).
 *
 * Listens to every channel message, and when the conversation contains an
 * actionable campaign request (Greek or English), interprets it with OpenAI
 * and applies the edit to the MailerLite draft bound to that channel.
 *
 * Flow:
 *   1. Cheap bilingual keyword pre-filter (no AI cost for ordinary chatter).
 *   2. AI intent classification: bind / edit / unbind / status / none.
 *      "Wow this looks amazing" → none. "We need to change the subject" → edit.
 *   3. Channel→campaign binding via natural language ("work on Spring Sale here").
 *   4. Edits applied immediately through the MailerLite API; the bot replies
 *      with a summary of what changed, in the language of the request.
 *
 * Env: MAILERLITE_API_KEY (required), OPENAI_API_KEY (required),
 *      MAILERLITE_INTENT_MODEL / MAILERLITE_EDIT_MODEL (optional overrides).
 */

const { message: openaiMessage, parseJsonResponse } = require('./openai');
const { splitDiscordMessages } = require('./sales-support');
const {
  isMailerLiteConfigured,
  listDraftCampaigns,
  getCampaign,
  updateCampaign,
} = require('./mailerlite-api');
const { getBinding, setBinding, clearBinding } = require('./mailerlite-channel-store');

const INTENT_CONFIDENCE_THRESHOLD = 0.6;
const MAX_CONTENT_CHARS = 60000;

// Channels with an edit currently in flight (prevents double-applying rapid messages).
const busyChannels = new Set();

function isMailerLiteFlowEnabled() {
  return isMailerLiteConfigured() && Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Bilingual pre-filter: only messages that mention campaign/email concepts
 * reach the AI classifier. Greek stems are accent-insensitive where possible.
 */
const PREFILTER_RE = new RegExp(
  [
    'campaign', 'newsletter', 'mailer\\s*lite', 'mailerlite',
    'e-?mail', 'subject\\s*line',
    'καμπάνι', 'καμπανι',          // καμπάνια, καμπάνιας, ...
    'μέιλ', 'μειλ', 'μέηλ', 'μεηλ',
    'προσχέδι', 'προσχεδι',        // προσχέδιο (draft)
    'ενημερωτικ',                  // ενημερωτικό δελτίο (newsletter)
  ].join('|'),
  'i',
);

function passesPrefilter(text) {
  return PREFILTER_RE.test(text);
}

function intentModel() {
  return process.env.MAILERLITE_INTENT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function editModel() {
  return process.env.MAILERLITE_EDIT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
}

/** Tiny bilingual reply helper. */
function t(lang, en, el) {
  return lang === 'el' ? el : en;
}

const INTENT_SYSTEM = `You classify Discord chat messages for a MailerLite email-campaign bot.
Messages are in Greek or English (often informal, sometimes Greeklish).

Return ONLY JSON:
{
  "intent": "bind" | "edit" | "unbind" | "status" | "none",
  "campaignName": string,   // campaign name mentioned, or "" if none
  "language": "el" | "en",  // language of the message (Greeklish counts as "el")
  "confidence": number      // 0..1
}

Intents:
- "bind": the author asks the bot to work on / focus on / attach a specific campaign in this channel.
  Examples: "bot, work on Spring Sale here", "δούλεψε την καμπάνια Πάσχα εδώ".
- "edit": an actionable request to change the campaign — subject, name, sender, reply-to,
  or content (text, headings, buttons, colors, images, structure, tone, translation).
  Examples: "we need to change the subject to X", "άλλαξε τον τίτλο", "κάνε το κουμπί κόκκινο",
  "the intro paragraph is too long, shorten it".
- "unbind": stop working on / forget the campaign in this channel.
- "status": asking which campaign is active here or what its current state is.
- "none": everything else — praise ("wow this looks amazing", "τέλειο!"), questions to other
  humans, general discussion ABOUT campaigns with no concrete change requested, sarcasm, memes.

Critical: opinions and reactions are NOT edits. Only classify "edit" when a concrete change
is being requested or clearly wished for ("we should make the header blue" counts;
"the header is blue" does not). When unsure, use "none" with low confidence.`;

async function classifyIntent({ content, binding }) {
  const bindingLine = binding
    ? `This channel is currently bound to campaign "${binding.campaignName}".`
    : 'This channel has no campaign bound yet.';

  const { text } = await openaiMessage({
    apiKey: process.env.OPENAI_API_KEY,
    model: intentModel(),
    system: INTENT_SYSTEM,
    user: `${bindingLine}\n\nMessage:\n${content}`,
    maxTokens: 300,
    timeoutMs: 30000,
  });

  return parseJsonResponse(text);
}

const EDIT_SYSTEM = `You edit MailerLite email campaign drafts based on Discord chat requests
(in Greek or English). You receive the current campaign and the requested change.

Return ONLY JSON:
{
  "changes": {
    // include ONLY the fields that must change:
    "name": string,      // internal campaign name
    "subject": string,   // email subject line
    "fromName": string,
    "fromEmail": string,
    "replyTo": string,
    "content": string    // FULL updated HTML document (only when content changes)
  },
  "summary": string      // 1-3 short lines describing what changed, in the "language" below
  ,"language": "el" | "en"
}

Rules:
- Apply exactly what was asked — do not invent extra changes.
- For content edits, return the COMPLETE updated HTML (the whole document, not a fragment),
  preserving all existing structure/styles except what the request changes.
- Keep the campaign's language: if the email is in Greek, edited copy stays Greek, unless
  a translation is explicitly requested.
- "summary" must be in the same language as the Discord request.
- If the request is impossible with the available fields, return an empty "changes" object
  and explain why in "summary".`;

async function interpretEdit({ content, campaign }) {
  const truncatedContent = campaign.content.length > MAX_CONTENT_CHARS
    ? `${campaign.content.slice(0, MAX_CONTENT_CHARS)}\n<!-- truncated -->`
    : campaign.content;

  const user = [
    'Current campaign:',
    JSON.stringify({
      name: campaign.name,
      subject: campaign.subject,
      fromName: campaign.fromName,
      fromEmail: campaign.fromEmail,
      replyTo: campaign.replyTo,
    }, null, 2),
    '',
    'Current HTML content:',
    truncatedContent || '(no content available)',
    '',
    'Discord request:',
    content,
  ].join('\n');

  const { text } = await openaiMessage({
    apiKey: process.env.OPENAI_API_KEY,
    model: editModel(),
    system: EDIT_SYSTEM,
    user,
    maxTokens: 16384,
    timeoutMs: 180000,
  });

  return parseJsonResponse(text);
}

async function replyChunked(message, text) {
  const chunks = splitDiscordMessages(text);
  if (!chunks.length) return;
  await message.reply(chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await message.channel.send(chunk);
  }
}

function formatDraftList(drafts, lang) {
  if (!drafts.length) {
    return t(lang,
      'There are no draft campaigns in MailerLite right now.',
      'Δεν υπάρχουν πρόχειρες καμπάνιες στο MailerLite αυτή τη στιγμή.');
  }
  const lines = drafts.slice(0, 15).map((d) => `• ${d.name}`);
  return `${t(lang, 'Available drafts:', 'Διαθέσιμα πρόχειρα:')}\n${lines.join('\n')}`;
}

function matchDrafts(drafts, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const exact = drafts.filter((d) => d.name.toLowerCase() === q);
  if (exact.length) return exact;
  return drafts.filter((d) => d.name.toLowerCase().includes(q) || q.includes(d.name.toLowerCase()));
}

async function handleBind(message, { campaignName, lang }) {
  const drafts = await listDraftCampaigns();

  if (!campaignName) {
    await replyChunked(message, [
      t(lang,
        'Which campaign should I work on in this channel?',
        'Ποια καμπάνια να δουλέψω σε αυτό το κανάλι;'),
      formatDraftList(drafts, lang),
    ].join('\n'));
    return;
  }

  const matches = matchDrafts(drafts, campaignName);

  if (matches.length === 1) {
    const campaign = matches[0];
    setBinding(message.channel.id, {
      campaignId: campaign.id,
      campaignName: campaign.name,
      boundBy: message.author.id,
    });
    await replyChunked(message, t(lang,
      `📌 Working on **${campaign.name}** in this channel. Tell me what to change.`,
      `📌 Δουλεύω την καμπάνια **${campaign.name}** σε αυτό το κανάλι. Πες μου τι να αλλάξω.`));
    return;
  }

  if (matches.length > 1) {
    await replyChunked(message, [
      t(lang,
        `I found ${matches.length} drafts matching "${campaignName}" — which one?`,
        `Βρήκα ${matches.length} πρόχειρα που ταιριάζουν με "${campaignName}" — ποιο από όλα;`),
      formatDraftList(matches, lang),
    ].join('\n'));
    return;
  }

  await replyChunked(message, [
    t(lang,
      `I couldn't find a draft named "${campaignName}".`,
      `Δεν βρήκα πρόχειρη καμπάνια με όνομα "${campaignName}".`),
    formatDraftList(drafts, lang),
  ].join('\n'));
}

async function handleEdit(message, { content, binding, lang }) {
  const campaign = await getCampaign(binding.campaignId);

  if (campaign.status && campaign.status !== 'draft') {
    await replyChunked(message, t(lang,
      `⚠️ **${campaign.name}** is "${campaign.status}" — only drafts can be edited. Bind another campaign here.`,
      `⚠️ Η καμπάνια **${campaign.name}** είναι "${campaign.status}" — μόνο πρόχειρα επεξεργάζονται. Δέσε άλλη καμπάνια εδώ.`));
    return;
  }

  const result = await interpretEdit({ content, campaign });
  const changes = result?.changes || {};
  const changedKeys = Object.keys(changes).filter((k) => changes[k] !== undefined && changes[k] !== null);
  const replyLang = result?.language || lang;

  if (!changedKeys.length) {
    await replyChunked(message, result?.summary || t(replyLang,
      "I couldn't turn that into a campaign change.",
      'Δεν μπόρεσα να το μετατρέψω σε αλλαγή της καμπάνιας.'));
    return;
  }

  const updated = await updateCampaign({ ...campaign, ...changes });

  // Keep the stored binding name in sync when the campaign is renamed.
  if (changes.name) {
    setBinding(message.channel.id, {
      campaignId: updated.id,
      campaignName: updated.name,
      boundBy: getBinding(message.channel.id)?.boundBy || message.author.id,
    });
  }

  await replyChunked(message, [
    t(replyLang, `✅ Updated **${updated.name}**:`, `✅ Ενημέρωσα την καμπάνια **${updated.name}**:`),
    result.summary || changedKeys.join(', '),
  ].join('\n'));
}

async function handleStatus(message, { binding, lang }) {
  if (!binding) {
    const drafts = await listDraftCampaigns();
    await replyChunked(message, [
      t(lang,
        'No campaign is bound to this channel. Say e.g. "work on <campaign name> here".',
        'Δεν υπάρχει καμπάνια δεμένη σε αυτό το κανάλι. Πες π.χ. "δούλεψε την <όνομα καμπάνιας> εδώ".'),
      formatDraftList(drafts, lang),
    ].join('\n'));
    return;
  }

  const campaign = await getCampaign(binding.campaignId);
  await replyChunked(message, t(lang,
    `📋 **${campaign.name}** (${campaign.status})\nSubject: ${campaign.subject || '—'}\nFrom: ${campaign.fromName || '—'} <${campaign.fromEmail || '—'}>`,
    `📋 **${campaign.name}** (${campaign.status})\nΘέμα: ${campaign.subject || '—'}\nΑπό: ${campaign.fromName || '—'} <${campaign.fromEmail || '—'}>`));
}

/**
 * Main entry — called for every non-bot channel message.
 * Returns true when the message was handled (bridge should stop processing it).
 */
async function handleMailerLiteMessage(message) {
  const content = (message.content || '').trim();
  if (!content || !passesPrefilter(content)) return false;

  const channelId = message.channel.id;
  if (busyChannels.has(channelId)) return false;

  const binding = getBinding(channelId);

  let intent;
  try {
    intent = await classifyIntent({ content, binding });
  } catch (error) {
    console.error('[mailerlite] intent classification failed:', error.message);
    return false;
  }

  if (!intent || intent.intent === 'none' || (intent.confidence ?? 0) < INTENT_CONFIDENCE_THRESHOLD) {
    return false;
  }

  const lang = intent.language === 'el' ? 'el' : 'en';
  console.log(`[mailerlite] intent=${intent.intent} conf=${intent.confidence} lang=${lang} #${message.channel?.name || channelId}`);

  busyChannels.add(channelId);
  try {
    if (intent.intent === 'bind') {
      await handleBind(message, { campaignName: intent.campaignName, lang });
      return true;
    }

    if (intent.intent === 'unbind') {
      const existed = clearBinding(channelId);
      await replyChunked(message, existed
        ? t(lang, '👋 Stopped working on the campaign in this channel.', '👋 Σταμάτησα να δουλεύω την καμπάνια σε αυτό το κανάλι.')
        : t(lang, 'No campaign was bound to this channel.', 'Δεν υπήρχε δεμένη καμπάνια σε αυτό το κανάλι.'));
      return true;
    }

    if (intent.intent === 'status') {
      await handleStatus(message, { binding, lang });
      return true;
    }

    // intent === 'edit'
    if (!binding) {
      const drafts = await listDraftCampaigns();
      await replyChunked(message, [
        t(lang,
          'I can do that, but no campaign is bound to this channel yet. Say e.g. "work on <campaign name> here".',
          'Μπορώ να το κάνω, αλλά δεν έχει δεθεί καμπάνια σε αυτό το κανάλι. Πες π.χ. "δούλεψε την <όνομα καμπάνιας> εδώ".'),
        formatDraftList(drafts, lang),
      ].join('\n'));
      return true;
    }

    await message.channel.sendTyping().catch(() => {});
    await handleEdit(message, { content, binding, lang });
    return true;
  } catch (error) {
    console.error('[mailerlite] flow failed:', error);
    await replyChunked(message, t(lang,
      `❌ Campaign update failed: ${error.message}`,
      `❌ Η ενημέρωση της καμπάνιας απέτυχε: ${error.message}`)).catch(() => {});
    return true;
  } finally {
    busyChannels.delete(channelId);
  }
}

module.exports = {
  isMailerLiteFlowEnabled,
  handleMailerLiteMessage,
};
