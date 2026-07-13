/**
 * Convert brief markdown to a .docx buffer for Discord attachment.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} = require('docx');

function normalizeBriefMarkdown(markdown) {
  let text = String(markdown || '').trim();
  text = text.replace(/^```(?:markdown|md)?\s*\r?\n?/i, '');
  text = text.replace(/\r?\n?```\s*$/i, '');
  return text.trim();
}

function parseInlineRuns(text) {
  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun(text.slice(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Courier New' }));
    } else if (token.startsWith('*') || token.startsWith('_')) {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    } else {
      runs.push(new TextRun(token));
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun(text.slice(lastIndex)));
  }

  return runs.length ? runs : [new TextRun(text)];
}

function isNumberedListItem(line) {
  return /^\d+\.\s/.test(line);
}

function markdownToDocxParagraphs(markdown) {
  const paragraphs = [];
  const lines = normalizeBriefMarkdown(markdown).split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      paragraphs.push(new Paragraph({ children: [new TextRun('')] }));
      continue;
    }

    if (/^```/.test(trimmed)) continue;
    if (/^---+$/.test(trimmed)) continue;

    if (trimmed.startsWith('# ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.slice(2).trim(),
        heading: HeadingLevel.HEADING_1,
      }));
      continue;
    }

    if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.slice(3).trim(),
        heading: HeadingLevel.HEADING_2,
      }));
      continue;
    }

    if (trimmed.startsWith('### ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.slice(4).trim(),
        heading: HeadingLevel.HEADING_3,
      }));
      continue;
    }

    if (trimmed.startsWith('- ')) {
      paragraphs.push(new Paragraph({
        children: parseInlineRuns(trimmed.slice(2).trim()),
        bullet: { level: 0 },
      }));
      continue;
    }

    // Inline "1. …" text — avoids broken Word numbering layouts in Pages/Word.
    if (isNumberedListItem(trimmed)) {
      paragraphs.push(new Paragraph({
        children: parseInlineRuns(trimmed),
        spacing: { after: 120 },
      }));
      continue;
    }

    if (trimmed.includes('|') && trimmed.startsWith('|')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.every((c) => /^-+$/.test(c))) continue;
      paragraphs.push(new Paragraph({
        children: [new TextRun(cells.join(' · '))],
      }));
      continue;
    }

    paragraphs.push(new Paragraph({
      children: parseInlineRuns(trimmed),
    }));
  }

  return paragraphs;
}

async function buildBriefDocxBuffer(markdown, { footer } = {}) {
  const children = markdownToDocxParagraphs(markdown);

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
  markdownToDocxParagraphs,
};
