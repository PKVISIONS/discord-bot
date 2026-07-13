/**
 * AI matcher — pick the best leads spreadsheet for an employee question.
 */

const { message, parseJsonResponse } = require('./openai');

async function matchLeadSpreadsheet({
  question,
  files,
  apiKey = process.env.OPENAI_API_KEY,
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  if (!files.length) {
    return {
      message: 'Δεν βρέθηκαν Excel αρχεία στον φάκελο leads του Google Drive.',
      fileName: null,
      fileUrl: null,
      confidence: 'low',
      reason: 'Empty folder listing.',
    };
  }

  const model = process.env.LEADS_MATCH_MODEL
    || process.env.OPENAI_MODEL
    || 'gpt-4o-mini';

  const catalog = files.map((file, index) => {
    const path = file.folderPath ? ` (${file.folderPath})` : '';
    return [
      `${index + 1}. ${file.name}${path}`,
      `   id: ${file.id}`,
      `   modified: ${file.modifiedTime || 'unknown'}`,
      `   link: ${file.webViewLink}`,
    ].join('\n');
  }).join('\n\n');

  const userPrompt = [
    'An employee asked which Google Drive Excel file contains specific company/product leads.',
    'Pick the single best matching file from the catalog below.',
    '',
    `Question: ${question}`,
    '',
    'Catalog:',
    catalog,
    '',
    'Return JSON only:',
    '{',
    '  "fileId": "must match an id from the catalog",',
    '  "confidence": "high" | "medium" | "low",',
    '  "reason": "one short sentence in Greek explaining the match"',
    '}',
    '',
    'Rules:',
    '- Use file names and folder paths only — do not invent files',
    '- Prefer exact product/company name matches (Emblem Tameiaki, SoftPOS, etc.)',
    '- If ambiguous, pick the most likely file and set confidence medium/low',
    '- If nothing fits, set fileId to the closest guess with low confidence',
  ].join('\n');

  const { text } = await message({
    apiKey,
    model,
    system: 'You match employee questions to spreadsheet filenames. Output valid JSON only.',
    user: userPrompt,
    maxTokens: 400,
    timeoutMs: Number(process.env.LEADS_MATCH_TIMEOUT_MS || 60000),
  });

  const parsed = parseJsonResponse(text);
  const match = files.find((f) => f.id === parsed.fileId)
    || files.find((f) => f.name === parsed.fileName);

  if (!match) {
    throw new Error(`AI picked unknown file id: ${parsed.fileId}`);
  }

  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
    ? parsed.confidence
    : 'medium';

  return {
    message: `Το πιο πιθανό αρχείο leads για την ερώτησή σου (${confidence}):`,
    fileName: match.name,
    fileUrl: match.webViewLink,
    confidence,
    reason: String(parsed.reason || '').trim() || 'Επιλέχθηκε από όνομα αρχείου.',
    folderPath: match.folderPath || null,
  };
}

module.exports = {
  matchLeadSpreadsheet,
};
