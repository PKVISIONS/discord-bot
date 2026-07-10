/**
 * Deliver sales-support answers and handle reply-to-ask-sources.
 */

const { splitDiscordMessages } = require('./sales-support');
const { isSourceFollowUpQuery } = require('./sales-support-sources');
const {
  saveSalesSupportContext,
  linkMessageToContext,
  findContextForReply,
} = require('./sales-support-context-store');

const SOURCE_HINT =
  '\n\n_💡 Για πηγές: γράψε **πηγές** ή **απάντησε** στο μήνυμά μου — π.χ. «από πού το βρήκες;» ή «sources»._';

function appendSourceHint(content, extraMessages = []) {
  if (!extraMessages.length) {
    return { content: `${content}${SOURCE_HINT}`, extraMessages: [] };
  }

  const last = extraMessages.length - 1;
  return {
    content,
    extraMessages: extraMessages.map((msg, index) => (
      index === last ? `${msg}${SOURCE_HINT}` : msg
    )),
  };
}

async function linkSentMessage(contextId, sent) {
  if (sent?.id) {
    linkMessageToContext(contextId, sent.id);
    return sent.id;
  }
  return null;
}

async function deliverSalesSupportResult({
  result,
  userId,
  threadId,
  sendMain,
  sendExtra,
  resolveMainMessage,
}) {
  const hinted = appendSourceHint(result.content, result.extraMessages || []);
  const contextId = result?.sourceBlock
    ? saveSalesSupportContext({
      userId,
      repoFullName: result.repoFullName,
      question: result.question,
      sourceBlock: result.sourceBlock,
      threadId,
    })
    : null;

  let mainMsg = await sendMain(hinted.content);
  if (!mainMsg?.id && resolveMainMessage) {
    mainMsg = await resolveMainMessage();
  }
  if (contextId) await linkSentMessage(contextId, mainMsg);

  for (const extra of hinted.extraMessages || []) {
    const extraMsg = await sendExtra(extra);
    if (contextId) await linkSentMessage(contextId, extraMsg);
  }

  if (!result?.sourceBlock) {
    return mainMsg;
  }

  return mainMsg;
}

async function tryHandleSalesSupportSourceReply(message, botUserId) {
  const content = (message.content || '').trim();
  if (!content) return false;

  const inThread = typeof message.channel?.isThread === 'function' && message.channel.isThread();
  if (!message.reference?.messageId && !inThread) return false;

  if (!isSourceFollowUpQuery(content, { hasStoredContext: inThread })) return false;

  const context = await findContextForReply(message);
  if (!context?.sourceBlock) {
    if (!message.reference?.messageId) return false;

    let refMsg;
    try {
      refMsg = await message.channel.messages.fetch(message.reference.messageId);
    } catch {
      return false;
    }

    if (refMsg.author?.id !== botUserId) return false;

    await message.reply(
      'Δεν έχω αποθηκευμένες πηγές για αυτό το μήνυμα. Κάνε νέο `/sales-support` στο `#tameiaki-ai-assistant` και μετά γράψε **πηγές** στο thread.',
    );
    return true;
  }

  const header = [
    `**Πηγές για:** \`${context.repoFullName}\``,
    context.question ? `_Ερώτηση: ${context.question}_` : null,
    '',
  ].filter(Boolean).join('\n');

  const chunks = splitDiscordMessages(`${header}${context.sourceBlock}`);
  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i += 1) {
    await message.channel.send(chunks[i]);
  }

  return true;
}

module.exports = {
  deliverSalesSupportResult,
  tryHandleSalesSupportSourceReply,
};
