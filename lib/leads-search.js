/**
 * Search all lead spreadsheets for a phone number or specific field value.
 */

const XLSX = require('xlsx');
const { listLeadSpreadsheets, downloadSpreadsheetBuffer } = require('./leads-drive');
const { parseLeadsQuery, cellToString, matchesCell } = require('./leads-query');
const { splitDiscordMessages } = require('./sales-support');

const MAX_MATCHES = Number(process.env.LEADS_SEARCH_MAX_MATCHES || 12);
const MAX_FILES = Number(process.env.LEADS_SEARCH_MAX_FILES || 0);
const FILE_CONCURRENCY = Number(process.env.LEADS_SEARCH_FILE_CONCURRENCY || 3);
const MAX_ROW_PREVIEW_COLS = Number(process.env.LEADS_SEARCH_PREVIEW_COLS || 6);

async function mapPool(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()),
  );
  return results;
}

function buildHeaderMap(row) {
  const headers = (row || []).map((cell, index) => {
    const label = cellToString(cell);
    return label || `Column ${index + 1}`;
  });
  return headers;
}

function rowPreview(headers, row) {
  const pairs = [];
  for (let i = 0; i < Math.min(headers.length, MAX_ROW_PREVIEW_COLS); i += 1) {
    const value = cellToString(row?.[i]);
    if (!value) continue;
    pairs.push(`**${headers[i]}:** ${value}`);
  }
  return pairs.join(' · ');
}

function searchWorkbookBuffer(buffer, fileMeta, query) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const matches = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows.length) continue;

    const headers = buildHeaderMap(rows[0]);

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!Array.isArray(row) || !row.length) continue;

      const hitCells = [];
      for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
        if (matchesCell(row[colIndex], query)) {
          hitCells.push({
            column: headers[colIndex] || `Column ${colIndex + 1}`,
            value: cellToString(row[colIndex]),
          });
        }
      }

      if (!hitCells.length) continue;

      matches.push({
        fileId: fileMeta.id,
        fileName: fileMeta.name,
        fileUrl: fileMeta.webViewLink,
        folderPath: fileMeta.folderPath || '',
        sheetName,
        rowNumber: rowIndex + 1,
        hitCells,
        preview: rowPreview(headers, row),
      });
    }
  }

  return matches;
}

async function searchFile(file, query) {
  try {
    const buffer = await downloadSpreadsheetBuffer(file);
    return searchWorkbookBuffer(buffer, file, query);
  } catch (error) {
    console.error(`[leads] skip ${file.name}: ${error.message}`);
    return [];
  }
}

function modeLabel(query) {
  switch (query.mode) {
    case 'phone':
      return 'τηλέφωνο';
    case 'email':
      return 'email';
    case 'afm':
      return 'ΑΦΜ';
    case 'text':
      return 'όρο';
    default:
      return 'τιμή';
  }
}

function formatSearchResults({ query, matches, filesScanned, filesTotal }) {
  if (!matches.length) {
    return {
      content: [
        `🔍 Δεν βρέθηκε **${modeLabel(query)}** \`${query.display}\` σε ${filesScanned} Excel αρχεία.`,
        filesScanned < filesTotal
          ? `_Σαρώθηκαν τα πρώτα ${filesScanned} από ${filesTotal} αρχεία (όριο LEADS_SEARCH_MAX_FILES)._`
          : null,
      ].filter(Boolean).join('\n'),
    };
  }

  const limited = matches.slice(0, MAX_MATCHES);
  const lines = [
    `🔍 **${limited.length}${matches.length > limited.length ? ` από ${matches.length}` : ''}** εγγραφές για **${modeLabel(query)}** \`${query.display}\``,
    `_Σαρώθηκαν ${filesScanned}/${filesTotal} αρχεία._`,
    '',
  ];

  for (const match of limited) {
    const folder = match.folderPath ? ` · \`${match.folderPath}\`` : '';
    const hits = match.hitCells.map((cell) => `${cell.column}: \`${cell.value}\``).join(' · ');
    lines.push(`📄 **${match.fileName}**${folder}`);
    lines.push(`Φύλλο: \`${match.sheetName}\` · Γραμμή: **${match.rowNumber}**`);
    lines.push(hits);
    if (match.preview) lines.push(match.preview);
    lines.push(`🔗 ${match.fileUrl}`);
    lines.push('');
  }

  if (matches.length > limited.length) {
    lines.push(`_…και ${matches.length - limited.length} ακόμα. Στενότερο όρο για λιγότερα αποτελέσματα._`);
  }

  const messages = splitDiscordMessages(lines.join('\n').trim());
  return {
    content: messages[0],
    extraMessages: messages.slice(1),
  };
}

async function searchLeadsAcrossSpreadsheets(question) {
  const query = parseLeadsQuery(question);
  if (query.mode === 'file') {
    return { mode: 'file', query };
  }

  const files = await listLeadSpreadsheets();
  const filesToScan = MAX_FILES > 0 ? files.slice(0, MAX_FILES) : files;
  const nestedMatches = await mapPool(filesToScan, FILE_CONCURRENCY, (file) => searchFile(file, query));
  const matches = nestedMatches.flat();

  return {
    mode: 'search',
    query,
    result: formatSearchResults({
      query,
      matches,
      filesScanned: filesToScan.length,
      filesTotal: files.length,
    }),
  };
}

module.exports = {
  searchLeadsAcrossSpreadsheets,
  searchWorkbookBuffer,
  formatSearchResults,
};
