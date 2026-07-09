/**
 * App status assistant — recent features + potential problems/risks.
 *
 * Uses:
 * - Recent code activity (branches, commits, merged PRs)
 * - Stored AI commit reviews (overallRisk + findings)
 * - Semantic retrieval over the knowledge index (wiki/faq/discord captures)
 */

const { message } = require('./openai');
const { fetchCodeActivity } = require('./code-activity');
const { getRecentReviewsForRepo } = require('./commit-review-store');
const { retrieveContext, isIndexEmpty } = require('./retrieval');
const { splitDiscordMessages } = require('./sales-support');

function clampText(text, maxLen) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 24)).trimEnd()}…(περικομμένο)`;
}

function buildActivitySummary(activity) {
  const defaultCommits = (activity?.commits || [])
    .filter((c) => c.branch === activity.defaultBranch)
    .slice(0, 10);

  const recentAcross = (activity?.commits || []).slice(0, 18);

  const merged = (activity?.mergedPrs || []).slice(0, 6);

  const mergedBlock = merged.length
    ? merged
      .map((pr) => `- #${pr.number} \`${pr.branch}\` → merged · ${pr.title}`)
      .join('\n')
    : '- (Δεν βρέθηκαν πρόσφατα merged PRs.)';

  const defaultBlock = defaultCommits.length
    ? defaultCommits.map((c) => `- \`${c.shortSha}\` ${c.date?.slice(0, 10) || '?'} · ${clampText(c.message, 120)}`).join('\n')
    : '- (Δεν βρέθηκαν commits στο default branch.)';

  const acrossBlock = recentAcross.length
    ? recentAcross
      .map((c) => `- \`${c.branch}\` \`${c.shortSha}\` ${c.date?.slice(0, 10) || '?'} · ${clampText(c.message, 90)}`)
      .join('\n')
    : '- (Δεν βρέθηκαν πρόσφατα commits.)';

  return [
    `Default branch: ${activity?.defaultBranch || '(n/a)'}`,
    `Branches: ${activity?.branchesSampled || 0}/${activity?.branchCount || 0}`,
    '',
    'Πρόσφατα merged PRs',
    mergedBlock,
    '',
    `Commits στο default branch (${activity?.defaultBranch || 'n/a'})`,
    defaultBlock,
    '',
    'Πρόσφατη δραστηριότητα (όλα τα branches)',
    acrossBlock,
  ].join('\n');
}

function buildReviewSummary(reviews) {
  if (!reviews?.length) {
    return '- (Δεν υπάρχουν αποθηκευμένα commit reviews για αυτό το repo.)';
  }

  const lines = [];
  for (const r of reviews.slice(0, 10)) {
    const risk = r.review?.overallRisk || 'unknown';
    const summary = r.review?.summary ? clampText(r.review.summary, 220) : clampText(r.commitMessage, 160);
    const topFindings = (r.review?.findings || [])
      .slice(0, 2)
      .map((f) => `${f.severity}: ${clampText(f.title, 90)}`)
      .join(' · ');

    lines.push(`- \`${r.shortSha}\` \`${r.branch}\` · Risk: ${risk}${topFindings ? ` · ${topFindings}` : ''}\n  ${summary}`);
  }

  return lines.join('\n');
}

function buildSystemPrompt() {
  return [
    'Είσαι senior tech lead για την Emblem Tamiaki / TechFlow.',
    '',
    'Απάντησε στα Ελληνικά (ή Αγγλικά αν η ερώτηση είναι Αγγλικά).',
    '',
    'Χρησιμοποίησε ΜΟΝΟ το παρεχόμενο context (activity, commit reviews, retrieval).',
    'Αν δεν υπάρχει αρκετή πληροφορία, πες τι λείπει και τι να ελεγχθεί εσωτερικά.',
    '',
    'ΔΟΜΗ ΑΠΑΝΤΗΣΗΣ (με επικεφαλίδες):',
    '1) **Πρόσφατα features / αλλαγές** (με βάση commits + reviews)',
    '2) **Πιθανά προβλήματα / ρίσκα** (με βάση overallRisk + findings + relevant docs από retrieval)',
    '3) **Τι να ελέγξετε πριν την επόμενη ενέργεια** (checklist 5-8 bullets)',
    '4) **Πού βρίσκεται το app “σήμερα”** (status-style 2-4 προτάσεις: τι φαίνεται έτοιμο, τι είναι υπό εξέλιξη)',
    '',
    'Κράτα την απάντηση συνοπτική — στοχεύε σε ~1200-1600 χαρακτήρες συνολικά.',
  ].join('\n');
}

async function runAppStatusAssistant({ question, repoFullName }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.APP_STATUS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const repo = repoFullName || process.env.GITHUB_REPO || 'semantic-software/EmblemTameiaki';
  const trimmedQuestion = (question || '').trim() || 'Σύνοψε πρόσφατα features/αλλαγές και πιθανές ανησυχίες.';

  const retrievalNamespaces = ['wiki', 'faq', 'commit-review', 'discord-capture'];

  const tokenBudget = Number(process.env.APP_STATUS_RETRIEVAL_TOKEN_BUDGET || 16000);
  const doRetrieval = !isIndexEmpty();

  const [activity, reviews, retrieval] = await Promise.all([
    fetchCodeActivity(repo),
    Promise.resolve(getRecentReviewsForRepo(repo, 12)),
    doRetrieval
      ? retrieveContext({ query: trimmedQuestion, namespaces: retrievalNamespaces, tokenBudget })
        .catch(() => null)
      : Promise.resolve(null),
  ]);

  const activitySummary = clampText(buildActivitySummary(activity), 12000);
  const reviewSummary = clampText(buildReviewSummary(reviews || []), 8000);
  const retrievalContent = clampText(retrieval?.content || '', 6000);

  const userPrompt = [
    `Repo: ${repo}`,
    '',
    'Ερώτηση:',
    trimmedQuestion,
    '',
    'Context: recent code activity',
    activitySummary,
    '',
    'Context: stored AI commit reviews',
    reviewSummary,
    '',
    'Context: relevant knowledge (semantic retrieval)',
    retrievalContent || '- (Δεν βρέθηκαν σχετικά έγγραφα στο index για αυτή την ερώτηση.)',
    '',
    'Παρήγαγε την απάντηση ακολουθώντας αυστηρά τη δομή.',
  ].join('\n');

  const system = buildSystemPrompt();

  const { text } = await message({
    apiKey,
    model,
    system,
    user: userPrompt,
    maxTokens: Number(process.env.APP_STATUS_MAX_TOKENS || 900),
    timeoutMs: Number(process.env.APP_STATUS_TIMEOUT_MS || 180000),
  });

  const messages = splitDiscordMessages(text.trim());
  return {
    content: messages[0],
    extraMessages: messages.slice(1),
    repoFullName: repo,
    retrievalUsed: !!retrieval?.content,
  };
}

async function deliverAppStatusResult({ interaction, message, progressMessage, result }) {
  const parts = [result.content, ...(result.extraMessages || [])].filter(Boolean);

  if (interaction) {
    await interaction.editReply(parts[0]);
    for (const part of parts.slice(1)) {
      await interaction.followUp({ content: part });
    }
    return;
  }

  if (message) {
    const first = parts[0];
    if (progressMessage?.edit) {
      try {
        await progressMessage.edit(first);
      } catch {
        await message.reply(first);
      }
    } else {
      await message.reply(first);
    }
    for (const part of parts.slice(1)) {
      await message.channel.send(part);
    }
  }
}

module.exports = {
  runAppStatusAssistant,
  deliverAppStatusResult,
};

