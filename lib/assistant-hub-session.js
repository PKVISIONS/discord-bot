/**
 * Hub channel sessions: one public thread per slash command.
 */

const { isAssistantHubChannel } = require('./assistant-hub');
const { createAssistantThread } = require('./assistant-thread');

function canUseHubThread(interaction) {
  const channel = interaction.channel;
  if (!channel || channel.isDMBased?.()) return false;
  if (!isAssistantHubChannel(interaction.channelId)) return false;
  if (typeof channel.threads?.create !== 'function') return false;
  return true;
}

function summarizeInteraction(interaction) {
  const name = interaction.commandName;
  const opt = (key) => interaction.options?.getString?.(key) || '';

  switch (name) {
    case 'sales-support':
      return opt('question') || 'ενημερωτικό πωλήσεων';
    case 'dev':
      return opt('question') || 'dev plan';
    case 'app-status':
      return opt('question') || 'κατάσταση app';
    case 'n8n-linear':
      return opt('command') || 'n8n-linear';
    case 'github-issue':
      return opt('title') || 'github issue';
    case 'deploy': {
      const type = opt('type') || 'deploy';
      const branch = opt('branch');
      return branch ? `${type} · ${branch}` : type;
    }
    case 'help':
      return 'οδηγός εντολών';
    default:
      return name;
  }
}

function buildInactiveSession(interaction, cmd) {
  const normalize = (payload) => (typeof payload === 'string' ? { content: payload } : payload);

  return {
    thread: null,
    anchor: null,
    commandName: cmd,
    inHub: false,
    notifyParent: async () => {},
    sendLoading: async (text) => {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(text);
      }
    },
    sendMain: async (payload) => {
      const normalized = normalize(payload);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(normalized);
        return interaction.fetchReply();
      }
      return interaction.reply({ ...normalized, fetchReply: true });
    },
    sendFollowUp: async (payload) => interaction.followUp(normalize(payload)),
    reply: async (payload) => {
      const normalized = normalize(payload);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(normalized);
        return interaction.fetchReply();
      }
      return interaction.reply({ ...normalized, fetchReply: true });
    },
    editReply: async (payload) => interaction.editReply(normalize(payload)),
    fetchMainMessage: () => interaction.fetchReply(),
  };
}

/**
 * @returns {Promise<HubSession>}
 */
async function createHubSession(interaction, { commandName, summary } = {}) {
  const cmd = commandName || interaction.commandName;
  const detail = summary ?? summarizeInteraction(interaction);

  if (!canUseHubThread(interaction)) {
    return buildInactiveSession(interaction, cmd);
  }

  let thread = null;
  let anchor = null;
  let parentNotified = false;
  const normalize = (payload) => (typeof payload === 'string' ? { content: payload } : payload);

  try {
    thread = await createAssistantThread(interaction.channel, {
      commandName: cmd,
      summary: detail,
      username: interaction.user.username,
      userTag: interaction.user.toString(),
    });
  } catch (error) {
    console.error(`[hub] thread create failed for /${cmd}:`, error.message);
    return buildInactiveSession(interaction, cmd);
  }

  const notifyParent = async () => {
    if (parentNotified) return;
    parentNotified = true;
    const link = `📎 **/${cmd.replace(/-/g, ' ')}:** ${thread}\n_Η απάντηση θα δημοσιευτεί στο thread._`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(link);
    } else {
      await interaction.reply(link);
    }
  };

  return {
    thread,
    anchor: null,
    commandName: cmd,
    inHub: true,
    notifyParent,
    sendLoading: async (text) => {
      await notifyParent();
      if (!anchor) {
        anchor = await thread.send(text);
      } else {
        await anchor.edit(text).catch(async () => {
          anchor = await thread.send(text);
        });
      }
    },
    sendMain: async (payload) => {
      await notifyParent();
      const normalized = normalize(payload);
      if (anchor) {
        await anchor.edit(normalized);
        return anchor;
      }
      const msg = await thread.send(normalized);
      anchor = msg;
      return msg;
    },
    sendFollowUp: async (payload) => {
      await notifyParent();
      return thread.send(normalize(payload));
    },
    reply: async (payload) => {
      if (!parentNotified) {
        await interaction.editReply(`📎 **/${cmd.replace(/-/g, ' ')}:** ${thread}`);
        parentNotified = true;
      }
      const msg = await thread.send(normalize(payload));
      if (!anchor) anchor = msg;
      return msg;
    },
    editReply: async (payload) => {
      if (anchor) {
        await anchor.edit(normalize(payload));
        return;
      }
      const msg = await thread.send(normalize(payload));
      anchor = msg;
    },
    fetchMainMessage: async () => {
      if (anchor) return anchor;
      const messages = await thread.messages.fetch({ limit: 10 });
      return messages.find((m) => m.author.id === interaction.client.user.id) || messages.first();
    },
  };
}

module.exports = {
  canUseHubThread,
  summarizeInteraction,
  createHubSession,
};
