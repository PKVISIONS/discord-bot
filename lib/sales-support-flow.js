/**
 * Interactive repo picker for /sales-support — always uses EmblemTameiaki.
 */

const { runSalesSupport } = require('./sales-support');
const { deliverSalesSupportResult } = require('./sales-support-delivery');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');

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
  handleSelectInteraction,
};
