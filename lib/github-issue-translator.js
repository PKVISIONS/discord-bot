/**
 * Translate GitHub issue title + description to English for repo issues.
 */

const { message, parseJsonResponse } = require('./openai');

async function translateGitHubIssueToEnglish({
  title,
  description,
  apiKey = process.env.OPENAI_API_KEY,
}) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — required to translate issues.');
  }

  const model = process.env.GITHUB_ISSUE_TRANSLATE_MODEL
    || process.env.GITHUB_ISSUE_CLASSIFY_MODEL
    || process.env.OPENAI_MODEL
    || 'gpt-4o-mini';

  const userPrompt = [
    'Translate this GitHub issue into clear English for developers.',
    '',
    `Title: ${title}`,
    '',
    'Description:',
    description?.trim() || '(no description provided)',
    '',
    'Return JSON only:',
    '{',
    '  "title": "English title",',
    '  "description": "English description (empty string if none)",',
    '  "wasTranslated": true | false',
    '}',
    '',
    'Rules:',
    '- Output must be English even if the input is Greek or mixed language',
    '- If already English, return the same text and wasTranslated: false',
    '- Keep product names, device models, and technical terms (Sunmi, SoftPOS, Cardlink, IRIS, etc.)',
    '- Preserve steps, lists, and structure in the description',
    '- Do not add information that was not in the original',
  ].join('\n');

  const { text } = await message({
    apiKey,
    model,
    system: 'You translate software issue reports to English. Output valid JSON only.',
    user: userPrompt,
    maxTokens: 2000,
    timeoutMs: Number(process.env.GITHUB_ISSUE_TRANSLATE_TIMEOUT_MS || 60000),
  });

  const parsed = parseJsonResponse(text);
  const translatedTitle = String(parsed.title || '').trim();
  const translatedDescription = String(parsed.description || '').trim();

  if (!translatedTitle) {
    throw new Error('AI returned an empty English issue title.');
  }

  return {
    title: translatedTitle,
    description: translatedDescription,
    wasTranslated: Boolean(parsed.wasTranslated),
  };
}

module.exports = {
  translateGitHubIssueToEnglish,
};
