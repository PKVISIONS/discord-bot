/**
 * Dev assistant flow — always uses EmblemTameiaki.
 */

const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');
const { runDevAssistant } = require('./dev-assistant');

const DEFAULT_REPO = getPrimaryRepoFullName();

async function resolveDevRepo(repoHint) {
  if (repoHint) {
    const resolved = await resolveRepoFromHint(repoHint);
    if (!resolved) return null;
    return resolved;
  }
  return DEFAULT_REPO;
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function slugifyFilename(text) {
  return String(text || 'plan')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'plan';
}

function buildDevMarkdownAttachment(result) {
  const answerText = result.fullText || [
    result.content,
    ...(result.extraMessages || []),
  ].join('\n\n');

  const lines = [
    '# Dev assistant — implementation plan',
    '',
    `- **Repository:** \`${result.repoFullName || 'n/a'}\``,
    `- **Generated:** ${new Date().toISOString()}`,
    '',
    '## Question',
    '',
    result.question || '',
    '',
    '---',
    '',
    '## Response',
    '',
    answerText,
  ];

  if (result.filesScanned?.length) {
    lines.push(
      '',
      '---',
      '',
      '## Files scanned from repo',
      '',
      ...result.filesScanned.map((f) => `- \`${f}\``),
    );
  }

  if (result.sources?.length) {
    lines.push('', '---', '', '## Knowledge sources used', '');
    for (const source of result.sources) {
      const title = source.title || source.sourcePath;
      lines.push(`- **${source.label}:** ${title}${source.url ? ` — ${source.url}` : ''}`);
    }
  }

  const filename = `dev-${slugifyFilename(result.question)}.md`;
  return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: filename });
}

async function deliverDevResult(interaction, result) {
  const attachment = buildDevMarkdownAttachment(result);

  await interaction.editReply({
    content: result.content,
    components: [],
  });

  for (const extra of result.extraMessages || []) {
    await interaction.followUp({ content: extra });
  }

  try {
    await interaction.followUp({
      content: `📎 **Full plan:** \`${attachment.name}\``,
      files: [attachment],
    });
    console.log(`[dev] attached markdown: ${attachment.name}`);
  } catch (error) {
    console.error('[dev] markdown attachment failed:', error);
    await interaction.followUp('⚠️ Could not attach the markdown file. Check bridge logs.').catch(() => {});
  }
}

async function startDevAssistantFlow({ userId, repoHint, question }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const trimmedQuestion = (question || '').trim();
  if (!trimmedQuestion) {
    throw new Error('Question is required. Example: `/dev question:How do we add retry logic to payment sync?`');
  }

  const repoFullName = await resolveDevRepo(repoHint);
  if (!repoFullName) {
    return {
      content: `Repository \`${repoHint}\` not found. This bot only uses \`EmblemTameiaki\` (\`${DEFAULT_REPO}\`).`,
    };
  }

  return runDevAssistant({ repoFullName, question: trimmedQuestion });
}

async function handleSelectInteraction(interaction) {
  if (!interaction.customId.startsWith('dev_assist:')) return false;

  if (interaction.customId.startsWith('dev_assist:repo:')) {
    await interaction.reply({
      content: 'The repo picker is no longer used — this bot only works with EmblemTameiaki. Run `/dev` again.',
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  startDevAssistantFlow,
  handleSelectInteraction,
  deliverDevResult,
  buildDevMarkdownAttachment,
};
