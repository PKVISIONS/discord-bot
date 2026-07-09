/**
 * Unified context for EmblemTameiaki: knowledge docs + code activity + commit reviews.
 *
 * Specific questions use semantic retrieval over the vector index (wiki + FAQ +
 * commit reviews + Discord captures). Briefings keep the curated doc list.
 */

const { buildKnowledgeContext, resolveKnowledgeRoot } = require('./knowledge-base');
const { fetchCodeActivity, formatCodeActivityForPrompt } = require('./code-activity');
const { getRecentReviewsForRepo, formatReviewsForPrompt } = require('./commit-review-store');
const { retrieveContext, isIndexEmpty } = require('./retrieval');

async function buildUnifiedEmblemContext({
  repoFullName,
  query,
  mode,
  faqNumbers,
  onProgress,
}) {
  const knowledgeRoot = resolveKnowledgeRoot(repoFullName);
  if (!knowledgeRoot) {
    throw new Error('EmblemTameiaki-Knowledge repo not found. Set KNOWLEDGE_REPO_PATH in .env.');
  }

  const useSemantic = mode === 'specific' && !isIndexEmpty();

  if (onProgress) {
    await onProgress(useSemantic
      ? 'Σημασιολογική αναζήτηση σε τεκμηρίωση + λύσεις + κώδικα…'
      : 'Φόρτωση γνώσης + κώδικα EmblemTameiaki…');
  }

  const [semantic, knowledge, activity, reviews] = await Promise.all([
    useSemantic ? retrieveContext({ query }) : Promise.resolve(null),
    useSemantic
      ? Promise.resolve(null)
      : Promise.resolve(buildKnowledgeContext(knowledgeRoot, { query, mode, faqNumbers })),
    fetchCodeActivity(repoFullName),
    Promise.resolve(getRecentReviewsForRepo(repoFullName, 40)),
  ]);

  const activityBlock = formatCodeActivityForPrompt(activity);

  const headerLines = [
    '# ΕΝΙΑΙΟ ΠΡΟΦΙΛ Emblem Tamiaki [ΕΣΩΤΕΡΙΚΑ — μην αναφέρεις στην έξοδο]',
    '',
    'Χρησιμοποίησε ΟΛΑ τα παρακάτω μαζί: τεκμηρίωση προϊόντος + τι έχει αλλάξει στον κώδικα (όλα τα branches) + AI reviews commits + καταγεγραμμένες λύσεις από Discord.',
    'Απάντησε ΜΟΝΟ με βάση τα στοιχεία που δίνονται εδώ. Αν δεν υπάρχει επαρκής πληροφορία, πες το ρητά αντί να μαντέψεις.',
    'Αν κάτι υπάρχει μόνο στον κώδικα (νέο feature/fix) αλλά όχι ακόμα στα docs, προτίμησε τον κώδικα για ακρίβεια.',
    'Αν τα docs λένε κάτι που αντιφάσκει με πρόσφατο commit/PR, πες στον συνάδελφο να επιβεβαιώσει — μην το πεις ως σίγουρο στον πελάτη.',
    '',
  ];

  const parts = [...headerLines];

  if (useSemantic) {
    parts.push(
      '## Σχετική γνώση (semantic retrieval: τεκμηρίωση + FAQ + λύσεις Discord + commit reviews)',
      semantic.content || '(Δεν βρέθηκε σχετική γνώση στο index.)',
    );
  } else {
    parts.push(
      '## Τεκμηρίωση προϊόντος (EmblemTameiaki-Knowledge)',
      knowledge.content,
    );
  }

  parts.push(
    '',
    '## Δραστηριότητα κώδικα (branches, PRs, commits)',
    activityBlock,
  );

  if (!useSemantic) {
    parts.push(
      '',
      '## AI ανασκόπηση commits (αποθηκευμένα)',
      formatReviewsForPrompt(reviews),
    );
  }

  const content = parts.join('\n');

  const knowledgeDocs = useSemantic
    ? semantic.sources.filter((s) => s.namespace === 'wiki' || s.namespace === 'faq').map((s) => s.sourcePath)
    : knowledge.docPaths;

  return {
    content,
    knowledgeDocs,
    knowledgeBranch: knowledge?.knowledgeBranch || null,
    knowledgeRoot,
    retrievalUsed: useSemantic,
    retrievalSources: useSemantic ? semantic.sources : [],
    confidence: useSemantic ? semantic.confidence : null,
    topScore: useSemantic ? semantic.topScore : null,
    branchCount: activity.branchCount,
    branchesSampled: activity.branchesSampled,
    commitCount: activity.commits.length,
    mergedPrCount: activity.mergedPrs.length,
    mergedPrs: activity.mergedPrs.slice(0, 8),
    reviewCount: reviews.length,
    reviews: reviews.slice(0, 12).map((r) => ({
      shortSha: r.shortSha,
      branch: r.branch,
      commitMessage: r.commitMessage,
    })),
    unified: true,
  };
}

module.exports = {
  buildUnifiedEmblemContext,
};
