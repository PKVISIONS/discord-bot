/**
 * Create public assistant threads in hub channels.
 */

const { ThreadAutoArchiveDuration } = require('discord.js');

function buildThreadName({ question, username }) {
  const date = new Date().toISOString().slice(0, 10);
  const snippet = String(question || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || 'ενημερωτικό';
  const user = String(username || 'user').replace(/[^\w.-]/g, '').slice(0, 20);
  const name = `${date} · ${snippet} · ${user}`;
  return name.slice(0, 100);
}

function buildThreadOpener({ question, userTag }) {
  if (question) {
    return `**Ερώτηση** (${userTag}):\n${question}`;
  }
  return `**Ενημερωτικό πωλήσεων & υποστήριξης** — ${userTag}`;
}

/**
 * @param {import('discord.js').TextChannel} parentChannel
 */
async function createAssistantThread(parentChannel, { question, username, userTag }) {
  const name = buildThreadName({ question, username });
  const thread = await parentChannel.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'sales-support assistant session',
  });

  await thread.send(buildThreadOpener({ question, userTag }));
  return thread;
}

module.exports = {
  buildThreadName,
  buildThreadOpener,
  createAssistantThread,
};
