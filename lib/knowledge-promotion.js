/**
 * Promote a solved Discord thread into curated knowledge.
 *
 * Trigger: a configured reaction (KNOWLEDGE_SOLVE_EMOJI) or a "kb save" reply.
 * Flow: gather the conversation → AI-extract a structured entry → persist to the
 * capture store → embed immediately so it is searchable → post a review preview.
 */

const { message } = require('./openai');
const captureStore = require('./knowledge-capture-store');
const { indexCaptureEntry } = require('./knowledge-indexer');
const { extractLinks, getCaptureChannels, resolveCaptureChannelId } = require('./discord-capture-log');

const SOLVE_EMOJI = process.env.KNOWLEDGE_SOLVE_EMOJI || '✅';
const CAPTURE_REPO = process.env.GITHUB_REPO || 'semantic-software/EmblemTameiaki';
const MAX_CONV_CHARS = 20000;

const EXTRACT_SYSTEM = `Είσαι βοηθός που εξάγει δομημένη γνώση από συζητήσεις υποστήριξης στο Discord.
Δεδομένης μιας συνομιλίας (πρόβλημα → λύση), βγάλε ΜΟΝΟ ό,τι τεκμηριώνεται στη συνομιλία.
Απάντησε ΜΟΝΟ με JSON αυτής της μορφής:
{
  "title": "σύντομος τίτλος (<=80 χαρακτήρες)",
  "problem": "τι πρόβλημα αντιμετώπιζε ο χρήστης",
  "symptoms": "πώς εκδηλωνόταν (μηνύματα, συμπεριφορά)",
  "rootCause": "η αιτία, αν αναφέρεται· αλλιώς κενό",
  "solution": "τα βήματα/η λύση που δούλεψε",
  "productArea": "περιοχή προϊόντος (π.χ. πληρωμές, εκτυπωτής, myDATA)",
  "tags": ["λέξεις-κλειδιά"]
}
Αν η συνομιλία δεν περιέχει ξεκάθαρη λύση, βάλε "solution": "" και συμπλήρωσε ό,τι υπάρχει.
Γράψε στα Ελληνικά. Μην εφευρίσκεις πληροφορίες.`;

function isSolveEmoji(emoji) {
  const name = emoji?.name || '';
  return name === SOLVE_EMOJI || name === 'white_check_mark' || name === '✅';
}

function safeParseJson(text) {
  try {
    const match = String(text).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

async function walkReplyChain(triggerMessage, channel, maxHops = 12) {
  const chain = [];
  let current = triggerMessage;
  for (let i = 0; i < maxHops; i += 1) {
    const refId = current.reference?.messageId;
    if (!refId) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const parent = await channel.messages.fetch(refId);
      chain.unshift(parent);
      current = parent;
    } catch {
      break;
    }
  }
  return chain;
}

async function gatherConversation(triggerMessage, client) {
  const channel = triggerMessage.channel;
  let msgs = [];
  let threadId = null;

  const isThread = typeof channel.isThread === 'function' && channel.isThread();
  if (isThread) {
    threadId = channel.id;
    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    msgs = fetched ? Array.from(fetched.values()) : [];
    const starter = await channel.fetchStarterMessage().catch(() => null);
    if (starter && !msgs.find((m) => m.id === starter.id)) msgs.push(starter);
  } else {
    const chain = await walkReplyChain(triggerMessage, channel);
    const recent = await channel.messages
      .fetch({ limit: 25, before: triggerMessage.id })
      .catch(() => null);
    const recentArr = recent ? Array.from(recent.values()) : [];
    const seen = new Set();
    msgs = [...chain, triggerMessage, ...recentArr].filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  msgs = msgs.filter((m) => (m.content && m.content.trim()) || m.attachments?.size);
  msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const participants = Array.from(new Set(msgs.map((m) => m.author?.username).filter(Boolean)));
  const links = Array.from(new Set(msgs.flatMap((m) => extractLinks(m.content))));

  let text = msgs
    .map((m) => `${m.author?.username || 'user'}: ${m.content || '(συνημμένο)'}`)
    .join('\n');
  if (text.length > MAX_CONV_CHARS) text = text.slice(-MAX_CONV_CHARS);

  const rootMessage = msgs[0] || triggerMessage;

  return {
    text,
    participants,
    links,
    threadId,
    channelId: channel.id,
    sourceMessageUrl: rootMessage.url || triggerMessage.url || '',
    sourceKey: threadId || rootMessage.id || triggerMessage.id,
    messageCount: msgs.length,
  };
}

async function extractSolution(conversationText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');
  const model = process.env.KNOWLEDGE_EXTRACT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';

  const { text } = await message({
    apiKey,
    model,
    system: EXTRACT_SYSTEM,
    user: conversationText,
    maxTokens: 900,
    timeoutMs: 90000,
  });

  return safeParseJson(text);
}

/**
 * Core promotion routine. Returns the saved capture entry (or null if no
 * meaningful conversation could be gathered).
 */
async function promote({ triggerMessage, client, triggeredBy }) {
  const conv = await gatherConversation(triggerMessage, client);
  if (!conv.text.trim()) return null;

  const extracted = (await extractSolution(conv.text)) || {};

  const entry = captureStore.saveCapture({
    repoFullName: CAPTURE_REPO,
    sourceKey: conv.sourceKey,
    title: extracted.title || 'Λύση από Discord',
    problem: extracted.problem || '',
    symptoms: extracted.symptoms || '',
    rootCause: extracted.rootCause || '',
    solution: extracted.solution || '',
    productArea: extracted.productArea || '',
    tags: Array.isArray(extracted.tags) ? extracted.tags : [],
    links: conv.links,
    participants: conv.participants,
    sourceMessageUrl: conv.sourceMessageUrl,
    channelId: conv.channelId,
    threadId: conv.threadId || '',
    status: 'captured',
    raw: conv.text,
  });

  // Embed immediately so it is searchable at once.
  await indexCaptureEntry(entry).catch((error) => {
    console.error('[promotion] embed failed:', error.message);
  });

  // Phase 4 preview (lazy require avoids a require cycle).
  try {
    const { postExtractionPreview } = require('./knowledge-review');
    await postExtractionPreview({ client, entry, triggeredBy });
  } catch (error) {
    console.error('[promotion] preview failed:', error.message);
  }

  return entry;
}

async function handleSolveReaction(reaction, user, { client }) {
  try {
    if (reaction.partial) await reaction.fetch();
  } catch {
    return false;
  }
  if (user?.bot) return false;
  if (!isSolveEmoji(reaction.emoji)) return false;

  let msg = reaction.message;
  if (msg.partial) {
    try { msg = await msg.fetch(); } catch { return false; }
  }

  // When capture channels are configured, only promote within them.
  if (getCaptureChannels().length && !resolveCaptureChannelId(msg)) return false;

  const entry = await promote({ triggerMessage: msg, client, triggeredBy: user });
  if (!entry) return false;
  console.log(`[promotion] captured "${entry.title}" via reaction from ${user?.username}`);
  return true;
}

async function handleKbSaveCommand(message, { client }) {
  const entry = await promote({ triggerMessage: message, client, triggeredBy: message.author });
  if (!entry) {
    await message.reply('Δεν βρήκα αρκετό περιεχόμενο για να αποθηκεύσω. Απάντησε στο νήμα/μήνυμα της λύσης.');
    return true;
  }

  const reviewNote = process.env.KNOWLEDGE_REVIEW_CHANNEL
    ? ' Στάλθηκε στο κανάλι έγκρισης για δημοσίευση στο wiki.'
    : '';
  await message.reply(`✅ Καταγράφηκε & έγινε searchable: **${entry.title}**.${reviewNote}`);
  return true;
}

module.exports = {
  SOLVE_EMOJI,
  isSolveEmoji,
  gatherConversation,
  extractSolution,
  promote,
  handleSolveReaction,
  handleKbSaveCommand,
};
