/**
 * Optional instant guidance for testers in escalation-watched channels.
 *
 * When ESCALATION_AUTO_HINT=true, the bot replies to likely questions with a
 * short, non-technical hint from the knowledge base. This does NOT cancel
 * escalation — if no human answers within escalationMinutes, devs are still tagged.
 */

const { message: openaiMessage } = require('./openai');
const { retrieveContext, isIndexEmpty } = require('./retrieval');
const { splitDiscordMessages } = require('./sales-support');

const HINT_SYSTEM = `Είσαι βοηθός QA / δοκιμών για την Emblem Tamiaki. Απαντάς σε συναδέλφους (testers, support, PM) που ΔΕΝ είναι developers.

ΣΤΟΧΟΣ: δώσε γρήγορη κατεύθυνση — τι ισχύει, τι να ελέγξουν, τι build/feature αφορά — χωρίς να αντικαταστήσεις developer.

ΚΑΝΟΝΕΣ:
- Απλά Ελληνικά, φιλικός τόνος, χωρίς jargon (όχι repos, branches, APIs εκτός αν είναι απαραίτητο).
- Μέγιστο ~8-12 γραμμές. Bullets OK.
- Αν δεν υπάρχει επαρκές context, πες τι χρειάζεται να διευκρινιστεί και πρότεινε hashtag (#production, #hardware, #refactor, κλπ) αν βοηθά.
- Μην εφευρίσκεις builds, versions, ή δυνατότητες.
- Τέλος: μία πρόταση ότι αν χρειάζεται developer θα ειδοποιηθεί αυτόματα αν δεν απαντηθεί.

Δομή:
**Γρήγορη κατεύθυνση** — η απάντηση
**Τι να ελέγξεις** — 2-4 bullets (optional)
**Hashtag tip** — optional, μόνο αν χρήσιμο`;

function isAutoHintEnabled() {
  return String(process.env.ESCALATION_AUTO_HINT || '').toLowerCase() === 'true';
}

async function maybePostEscalationHint(discordMessage) {
  if (!isAutoHintEnabled()) return;
  if (!process.env.OPENAI_API_KEY) return;

  const question = (discordMessage.content || '').trim();
  if (!question) return;

  const model = process.env.ESCALATION_HINT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  let evidence = '';
  if (!isIndexEmpty()) {
    try {
      const retrieval = await retrieveContext({ query: question, topK: 12 });
      evidence = retrieval.content || '';
    } catch {
      evidence = '';
    }
  }

  const userPrompt = [
    `Κανάλι: #${discordMessage.channel?.name || 'unknown'}`,
    '',
    evidence ? `## Context\n${evidence.slice(0, 35000)}` : '## Context\n(Δεν βρέθηκε σχετική τεκμηρίωση στο index.)',
    '',
    '## Ερώτηση',
    question,
  ].join('\n');

  const { text } = await openaiMessage({
    apiKey: process.env.OPENAI_API_KEY,
    model,
    system: HINT_SYSTEM,
    user: userPrompt,
    maxTokens: 700,
    timeoutMs: 90000,
  });

  const footer = '\n\n_💡 Προσωρινή καθοδήγηση — αν δεν απαντηθεί από άνθρωπο, θα ειδοποιηθούν αυτόματα οι υπεύθυνοι dev._';
  const chunks = splitDiscordMessages(`${text.trim()}${footer}`, 1900);

  await discordMessage.reply({
    content: chunks[0],
    allowedMentions: { repliedUser: false },
  });

  for (let i = 1; i < chunks.length; i += 1) {
    await discordMessage.channel.send(chunks[i]);
  }

  console.log(`[escalation] auto-hint posted for ${discordMessage.id} in #${discordMessage.channel?.name}`);
}

module.exports = {
  isAutoHintEnabled,
  maybePostEscalationHint,
};
