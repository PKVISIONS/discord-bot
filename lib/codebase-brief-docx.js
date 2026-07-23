/**
 * Convert brief markdown to a .docx buffer for Discord attachment.
 * Markdown pipe-tables become real Word tables.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  VerticalAlign,
} = require('docx');

const PAGE_WIDTH_DXA = 9026; // ~A4 content width

function normalizeBriefMarkdown(markdown) {
  let text = String(markdown || '').trim();
  text = text.replace(/^```(?:markdown|md)?\s*\r?\n?/i, '');
  text = text.replace(/\r?\n?```\s*$/i, '');
  return text.trim();
}

function parseInlineRuns(text, { bold = false } = {}) {
  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), bold }));
    }

    const token = match[0];
    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Courier New', bold }));
    } else if (token.startsWith('*') || token.startsWith('_')) {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true, bold }));
    } else {
      runs.push(new TextRun({ text: token, bold }));
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), bold }));
  }

  return runs.length ? runs : [new TextRun({ text: String(text || ''), bold })];
}

function isNumberedListItem(line) {
  return /^\d+\.\s/.test(line);
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.includes('|');
}

function isTableSeparator(line) {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function tableBorders() {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D6D3D1' };
  return {
    top: border,
    bottom: border,
    left: border,
    right: border,
  };
}

function buildTableCell(text, { header = false, width } = {}) {
  return new TableCell({
    borders: tableBorders(),
    width: { size: width, type: WidthType.DXA },
    shading: header
      ? { type: ShadingType.CLEAR, fill: '134E4A' }
      : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        children: parseInlineRuns(text, {
          bold: header,
        }).map((run) => {
          // Header text in white
          if (!header) return run;
          return new TextRun({
            text: run.root?.[1]?.root?.[1] || String(text || ''),
            bold: true,
            color: 'FFFFFF',
            size: 18,
          });
        }),
        spacing: { before: 40, after: 40 },
      }),
    ],
  });
}

function buildTableCellSimple(text, { header = false, width } = {}) {
  return new TableCell({
    borders: tableBorders(),
    width: { size: width, type: WidthType.DXA },
    shading: header
      ? { type: ShadingType.CLEAR, fill: '134E4A' }
      : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: String(text || ''),
            bold: header,
            color: header ? 'FFFFFF' : '1C1917',
            size: header ? 18 : 18,
          }),
        ],
        spacing: { before: 40, after: 40 },
      }),
    ],
  });
}

function buildWordTable(rows) {
  if (!rows.length) return null;
  const colCount = Math.max(...rows.map((row) => row.length));
  if (!colCount) return null;

  // Prefer wider first column for commit titles when 3 columns.
  const widths = colCount === 3
    ? [5200, 1900, 1926]
    : Array.from({ length: colCount }, () => Math.floor(PAGE_WIDTH_DXA / colCount));

  const tableRows = rows.map((row, rowIndex) => {
    const cells = [];
    for (let i = 0; i < colCount; i += 1) {
      cells.push(buildTableCellSimple(row[i] || '', {
        header: rowIndex === 0,
        width: widths[i] || Math.floor(PAGE_WIDTH_DXA / colCount),
      }));
    }
    return new TableRow({ children: cells });
  });

  return new Table({
    width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows: tableRows,
  });
}

function markdownToDocxChildren(markdown) {
  const children = [];
  const lines = normalizeBriefMarkdown(markdown).split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      children.push(new Paragraph({ children: [new TextRun('')] }));
      i += 1;
      continue;
    }

    // Collect markdown table block into a real Word table.
    if (isTableRow(trimmed)) {
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i += 1;
      }

      const rows = tableLines
        .filter((rowLine) => !isTableSeparator(rowLine))
        .map(splitTableCells);

      const table = buildWordTable(rows);
      if (table) {
        children.push(table);
        children.push(new Paragraph({ children: [new TextRun('')] }));
      }
      continue;
    }

    if (/^```/.test(trimmed)) {
      i += 1;
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      children.push(new Paragraph({
        text: trimmed.slice(2).trim(),
        heading: HeadingLevel.HEADING_1,
      }));
      i += 1;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      children.push(new Paragraph({
        text: trimmed.slice(3).trim(),
        heading: HeadingLevel.HEADING_2,
      }));
      i += 1;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      children.push(new Paragraph({
        text: trimmed.slice(4).trim(),
        heading: HeadingLevel.HEADING_3,
      }));
      i += 1;
      continue;
    }

    if (trimmed.startsWith('- ')) {
      children.push(new Paragraph({
        children: parseInlineRuns(trimmed.slice(2).trim()),
        bullet: { level: 0 },
      }));
      i += 1;
      continue;
    }

    if (isNumberedListItem(trimmed)) {
      children.push(new Paragraph({
        children: parseInlineRuns(trimmed),
        spacing: { after: 120 },
      }));
      i += 1;
      continue;
    }

    children.push(new Paragraph({
      children: parseInlineRuns(trimmed),
    }));
    i += 1;
  }

  return children;
}

async function buildBriefDocxBuffer(markdown, { footer } = {}) {
  const children = markdownToDocxChildren(markdown);

  if (footer) {
    children.push(
      new Paragraph({ children: [new TextRun('')] }),
      new Paragraph({
        children: [new TextRun({ text: footer, italics: true, size: 18 })],
      }),
    );
  }

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

module.exports = {
  normalizeBriefMarkdown,
  buildBriefDocxBuffer,
  markdownToDocxChildren,
  markdownToDocxParagraphs: markdownToDocxChildren,
};
