/**
 * Human review of captured knowledge → curated wiki PR.
 *
 * Posts an extraction preview to KNOWLEDGE_REVIEW_CHANNEL. A maintainer approves
 * by reacting with KNOWLEDGE_APPROVE_EMOJI, which writes a curated markdown file
 * into the knowledge repo under docs/operations/solutions/{slug}.md and opens a PR.
 */

const captureStore = require('./knowledge-capture-store');
const { createClientForFullName } = require('./github-api');

const REVIEW_CHANNEL = process.env.KNOWLEDGE_REVIEW_CHANNEL || '';
const APPROVE_EMOJI = process.env.KNOWLEDGE_APPROVE_EMOJI || '✅';
const KNOWLEDGE_GITHUB_REPO = process.env.KNOWLEDGE_GITHUB_REPO
  || 'semantic-software/EmblemTameiaki-Knowledge';
const KNOWLEDGE_BASE_BRANCH = process.env.KNOWLEDGE_REPO_BRANCH || 'main';

function isApproveEmoji(emoji) {
  const name = emoji?.name || '';
  return name === APPROVE_EMOJI || name === 'white_check_mark' || name === '✅';
}

const GREEK_MAP = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i',
  κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's',
  ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

function transliterateGreek(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split('')
    .map((ch) => GREEK_MAP[ch] ?? ch)
    .join('');
}

function slugify(text) {
  const base = transliterateGreek(text || 'solution')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
  return base || 'solution';
}

function previewText(entry) {
  const lines = [
    '**🧠 Νέα καταγεγραμμένη λύση — για έγκριση**',
    `**Τίτλος:** ${entry.title}`,
    entry.productArea ? `**Περιοχή:** ${entry.productArea}` : null,
    entry.tags?.length ? `**Tags:** ${entry.tags.join(', ')}` : null,
    entry.problem ? `**Πρόβλημα:** ${entry.problem}` : null,
    entry.symptoms ? `**Συμπτώματα:** ${entry.symptoms}` : null,
    entry.rootCause ? `**Αιτία:** ${entry.rootCause}` : null,
    entry.solution ? `**Λύση:** ${entry.solution}` : null,
    entry.sourceMessageUrl ? `**Πηγή:** ${entry.sourceMessageUrl}` : null,
    '',
    `Αντίδρασε με ${APPROVE_EMOJI} για δημοσίευση στο wiki (άνοιγμα PR).`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function curatedMarkdown(entry) {
  const front = [
    '---',
    `title: ${JSON.stringify(entry.title)}`,
    entry.productArea ? `area: ${JSON.stringify(entry.productArea)}` : null,
    entry.tags?.length ? `tags: [${entry.tags.map((t) => JSON.stringify(t)).join(', ')}]` : null,
    `source: discord`,
    entry.sourceMessageUrl ? `sourceUrl: ${JSON.stringify(entry.sourceMessageUrl)}` : null,
    `capturedAt: ${entry.createdAt}`,
    '---',
    '',
  ].filter((l) => l !== null).join('\n');

  const body = [
    `# ${entry.title}`,
    '',
    entry.problem ? `## Πρόβλημα\n${entry.problem}` : null,
    entry.symptoms ? `## Συμπτώματα\n${entry.symptoms}` : null,
    entry.rootCause ? `## Αιτία\n${entry.rootCause}` : null,
    entry.solution ? `## Λύση\n${entry.solution}` : null,
    entry.links?.length ? `## Σύνδεσμοι\n${entry.links.map((l) => `- ${l}`).join('\n')}` : null,
    entry.participants?.length ? `\n_Συμμετέχοντες: ${entry.participants.join(', ')}_` : null,
  ].filter((l) => l !== null).join('\n\n');

  return `${front}${body}\n`;
}

/**
 * Post an extraction preview to the review channel and mark the capture as
 * pending review. No-op if no review channel is configured.
 */
async function postExtractionPreview({ client, entry }) {
  if (!REVIEW_CHANNEL) return null;
  const channel = await client.channels.fetch(REVIEW_CHANNEL).catch(() => null);
  if (!channel || typeof channel.send !== 'function') {
    console.error('[review] review channel not found or not text-based:', REVIEW_CHANNEL);
    return null;
  }

  const sent = await channel.send(previewText(entry));
  await sent.react(APPROVE_EMOJI).catch(() => {});

  captureStore.updateCaptureStatus(entry.repoFullName, entry.id, 'pending-review', {
    previewMessageId: sent.id,
    reviewChannelId: channel.id,
  });

  return sent;
}

function findCaptureByPreviewMessage(previewMessageId) {
  for (const repo of captureStore.listTrackedRepos()) {
    const found = captureStore.getAllCaptures(repo)
      .find((e) => e.previewMessageId === previewMessageId);
    if (found) return found;
  }
  return null;
}

async function publishToWiki(entry) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, KNOWLEDGE_GITHUB_REPO);
  const baseSha = await client.getBranchSha(repo, KNOWLEDGE_BASE_BRANCH);

  const slug = slugify(entry.title);
  const branch = await client.createBranch(repo, `kb/discord-${slug}-${Date.now()}`, baseSha);
  const filePath = `docs/operations/solutions/${slug}.md`;

  await client.upsertFile(
    repo,
    filePath,
    branch,
    curatedMarkdown(entry),
    `docs: capture solution "${entry.title}" from Discord`,
  );

  const pr = await client.createPullRequest(
    repo,
    `KB: ${entry.title}`,
    branch,
    KNOWLEDGE_BASE_BRANCH,
    [
      'Αυτόματη καταγραφή λύσης από Discord μέσω του bot.',
      '',
      entry.sourceMessageUrl ? `Πηγή: ${entry.sourceMessageUrl}` : '',
      `Αρχείο: \`${filePath}\``,
    ].filter(Boolean).join('\n'),
  );

  return { prUrl: pr.html_url, filePath, branch };
}

/**
 * Handle an approval reaction in the review channel. Returns true if it acted.
 */
async function handleReviewApprovalReaction(reaction, user, { client }) {
  if (!REVIEW_CHANNEL) return false;
  try {
    if (reaction.partial) await reaction.fetch();
  } catch {
    return false;
  }
  if (user?.bot) return false;
  if (!isApproveEmoji(reaction.emoji)) return false;

  let msg = reaction.message;
  if (msg.partial) {
    try { msg = await msg.fetch(); } catch { return false; }
  }
  if (msg.channel?.id !== REVIEW_CHANNEL) return false;

  const entry = findCaptureByPreviewMessage(msg.id);
  if (!entry) return false;
  if (entry.status === 'published') {
    await msg.reply('Έχει ήδη δημοσιευτεί.').catch(() => {});
    return true;
  }

  try {
    const result = await publishToWiki(entry);
    captureStore.updateCaptureStatus(entry.repoFullName, entry.id, 'published', {
      prUrl: result.prUrl,
      wikiPath: result.filePath,
    });
    await msg.reply(`✅ Άνοιξε PR στο wiki: ${result.prUrl}`);
    console.log(`[review] published "${entry.title}" → ${result.prUrl}`);
  } catch (error) {
    console.error('[review] publish failed:', error.message);
    await msg.reply(`Απέτυχε το άνοιγμα PR: ${error.message}`).catch(() => {});
  }
  return true;
}

module.exports = {
  REVIEW_CHANNEL,
  APPROVE_EMOJI,
  isApproveEmoji,
  slugify,
  curatedMarkdown,
  postExtractionPreview,
  handleReviewApprovalReaction,
  publishToWiki,
};
