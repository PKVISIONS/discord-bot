/**
 * Interactive repo picker for /sales-support — always uses EmblemTameiaki.
 */

const { runSalesSupport } = require('./sales-support');
const { deliverSalesSupportResult } = require('./sales-support-delivery');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');
const { createHubSession } = require('./assistant-hub-session');

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

async function handleSalesSupportInteraction(interaction, hubSession = null) {
  const question = interaction.options.getString('question');
  const parsed = { repoHint: null, question: question || null };
  const session = hubSession || await createHubSession(interaction);

  await session.sendLoading('⏳ Ετοιμασία απάντησης…');

  const response = await startSalesSupportFlow({
    userId: interaction.user.id,
    parsed,
  });

  if (response.components?.length) {
    await session.sendMain({
      content: response.content,
      components: response.components,
    });
    return;
  }

  await deliverSalesSupportResult({
    result: response,
    userId: interaction.user.id,
    threadId: session.thread?.id || null,
    sendMain: (content) => session.sendMain(content),
    sendExtra: (content) => session.sendFollowUp(content),
    resolveMainMessage: () => session.fetchMainMessage(),
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
