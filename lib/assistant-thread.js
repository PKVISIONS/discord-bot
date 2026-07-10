/**
 * Create public assistant threads in hub channels.
 */

const { ThreadAutoArchiveDuration } = require('discord.js');

function buildThreadName({ commandName, question, summary, username }) {
  const date = new Date().toISOString().slice(0, 10);
  const snippet = String(summary || question || commandName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || 'session';
  const user = String(username || 'user').replace(/[^\w.-]/g, '').slice(0, 20);
  const prefix = commandName ? `${commandName} · ` : '';
  const name = `${date} · ${prefix}${snippet} · ${user}`;
  return name.slice(0, 100);
}

function buildThreadOpener({ commandName, question, summary, userTag }) {
  const label = String(commandName || 'assistant').replace(/-/g, ' ');
  const detail = String(summary || question || '').trim();
  if (detail) {
    return `**/${label}** (${userTag}):\n${detail}`;
  }
  return `**/${label}** — ${userTag}`;
}

/**
 * @param {import('discord.js').TextChannel} parentChannel
 */
async function createAssistantThread(parentChannel, {
  commandName,
  question,
  summary,
  username,
  userTag,
}) {
  const name = buildThreadName({ commandName, question, summary, username });
  const thread = await parentChannel.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `assistant /${commandName || 'command'} session`,
  });

  await thread.send(buildThreadOpener({ commandName, question, summary, userTag }));
  return thread;
}

module.exports = {
  buildThreadName,
  buildThreadOpener,
  createAssistantThread,
};
