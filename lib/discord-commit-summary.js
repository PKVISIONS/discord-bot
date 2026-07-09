/**
 * Post commit reviews to the Discord #Commit-Summary channel.
 */

const DEFAULT_CHANNEL_NAME = 'Commit-Summary';

async function resolveCommitSummaryChannel(client) {
  const channelId = process.env.DISCORD_COMMIT_SUMMARY_CHANNEL_ID || '';
  const channelName = process.env.DISCORD_COMMIT_SUMMARY_CHANNEL || DEFAULT_CHANNEL_NAME;
  const guildId = process.env.DISCORD_GUILD_ID || '';

  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) return channel;
    throw new Error(`DISCORD_COMMIT_SUMMARY_CHANNEL_ID=${channelId} is missing or not a text channel.`);
  }

  if (!guildId) {
    throw new Error('Set DISCORD_GUILD_ID or DISCORD_COMMIT_SUMMARY_CHANNEL_ID for commit reviews.');
  }

  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const match = channels.find(
    (ch) => ch?.isTextBased() && ch.name.toLowerCase() === channelName.toLowerCase(),
  );

  if (!match) {
    throw new Error(
      `Discord channel #${channelName} not found in guild ${guildId}. Create it and grant the bot Send Messages.`,
    );
  }

  return match;
}

async function postCommitSummary(client, messages) {
  const channel = await resolveCommitSummaryChannel(client);
  const list = Array.isArray(messages) ? messages : [messages];

  for (let i = 0; i < list.length; i += 1) {
    const content = list[i];
    if (!content?.trim()) continue;
    await channel.send({ content });
  }

  return channel;
}

module.exports = {
  resolveCommitSummaryChannel,
  postCommitSummary,
  DEFAULT_CHANNEL_NAME,
};
