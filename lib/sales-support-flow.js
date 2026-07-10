/**
 * Interactive repo picker for /sales-support — always uses EmblemTameiaki.
 */

const { runSalesSupport } = require('./sales-support');
const { deliverSalesSupportResult } = require('./sales-support-delivery');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');
const { isAssistantHubChannel } = require('./assistant-hub');
const { createAssistantThread } = require('./assistant-thread');

async function resolveSalesSupportRepo(repoHint) {
  if (repoHint) {
    const resolved = await resolveRepoFromHint(repoHint);
    if (!resolved) return null;
    return resolved;
  }
  return getPrimaryRepoFullName();
}

async function startSalesSupportFlow({ userId, parsed }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const repoFullName = await resolveSalesSupportRepo(parsed?.repoHint);
  if (!repoFullName) {
    return {
      content: `Δεν βρέθηκε το repo \`${parsed.repoHint}\`. Το bot χρησιμοποιεί μόνο το \`EmblemTameiaki\` (\`${getPrimaryRepoFullName()}\`).`,
    };
  }

  return runSalesSupport({
    repoFullName,
    question: parsed?.question,
  });
}

function canCreateHubThread(interaction) {
  const channel = interaction.channel;
  if (!channel || channel.isDMBased?.()) return false;
  if (!isAssistantHubChannel(interaction.channelId)) return false;
  if (typeof channel.threads?.create !== 'function') return false;
  return true;
}

async function handleSalesSupportInteraction(interaction) {
  const question = interaction.options.getString('question');
  const parsed = { repoHint: null, question: question || null };
  const useThread = canCreateHubThread(interaction);

  let thread = null;
  let anchorMessage = null;

  if (useThread) {
    await interaction.editReply('⏳ Άνοιγμα νέας συζήτησης…');
    try {
      thread = await createAssistantThread(interaction.channel, {
        question: parsed.question,
        username: interaction.user.username,
        userTag: interaction.user.toString(),
      });
      anchorMessage = await thread.send('⏳ Ετοιμασία απάντησης…');
      await interaction.editReply(
        `📎 **Νέα συζήτηση:** ${thread}\n_Η απάντηση θα δημοσιευτεί στο thread — follow-up και «πηγές» εκεί._`,
      );
    } catch (error) {
      console.error('[sales-support] thread create failed:', error.message);
      thread = null;
      await interaction.editReply('⏳ Ετοιμασία απάντησης (δεν δημιουργήθηκε thread)…');
    }
  } else {
    await interaction.editReply('⏳ Ετοιμασία ενημερωτικού πωλήσεων & υποστήριξης…');
  }

  const response = await startSalesSupportFlow({
    userId: interaction.user.id,
    parsed,
  });

  if (response.components?.length) {
    const payload = { content: response.content, components: response.components };
    if (thread) {
      await thread.send(payload);
    } else {
      await interaction.editReply(payload);
    }
    return;
  }

  const sendMain = async (content) => {
    if (anchorMessage) {
      await anchorMessage.edit(content);
      return anchorMessage;
    }
    if (thread) {
      return thread.send(content);
    }
    await interaction.editReply(content);
    return interaction.fetchReply();
  };

  const sendExtra = async (content) => {
    const target = thread || interaction.channel;
    return target.send(content);
  };

  const resolveMainMessage = async () => {
    if (anchorMessage) return anchorMessage;
    if (thread) {
      const messages = await thread.messages.fetch({ limit: 5 });
      return messages.find((m) => m.author.id === interaction.client.user.id) || messages.first();
    }
    return interaction.fetchReply();
  };

  await deliverSalesSupportResult({
    result: response,
    userId: interaction.user.id,
    threadId: thread?.id || null,
    sendMain,
    sendExtra,
    resolveMainMessage,
  });
}

async function handleSelectInteraction(interaction) {
  if (!interaction.customId.startsWith('sales_support:')) return false;

  if (interaction.customId.startsWith('sales_support:repo:')) {
    await interaction.reply({
      content: 'Το repo picker δεν χρησιμοποιείται πλέον — το bot δουλεύει μόνο με EmblemTameiaki. Τρέξε `/sales-support` ξανά.',
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  startSalesSupportFlow,
  handleSalesSupportInteraction,
  handleSelectInteraction,
};
