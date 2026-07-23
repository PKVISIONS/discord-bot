/**
 * Convert brief markdown (with optional embedded HTML tables) to an HTML document.
 */

function normalizeBriefMarkdown(markdown) {
  let text = String(markdown || '').trim();
  text = text.replace(/^```(?:markdown|md)?\s*\r?\n?/i, '');
  text = text.replace(/\r?\n?```\s*$/i, '');
  return text.trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdownToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
  return html;
}

function isNumberedListItem(line) {
  return /^\d+\.\s/.test(line);
}

function flushList(items, tag) {
  if (!items.length) return '';
  return `<${tag}>\n${items.map((item) => `  <li>${item}</li>`).join('\n')}\n</${tag}>`;
}

/**
 * Convert brief markdown to HTML body fragments.
 * Raw HTML blocks (e.g. <table>…</table>) are preserved as-is.
 */
function markdownToHtmlFragments(markdown) {
  const lines = normalizeBriefMarkdown(markdown).split('\n');
  const fragments = [];
  let bulletItems = [];
  let numberedItems = [];
  let inHtmlBlock = false;
  let htmlBuffer = [];

  const flushLists = () => {
    if (bulletItems.length) {
      fragments.push(flushList(bulletItems, 'ul'));
      bulletItems = [];
    }
    if (numberedItems.length) {
      fragments.push(flushList(numberedItems, 'ol'));
      numberedItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (inHtmlBlock) {
      htmlBuffer.push(line);
      if (/<\/(table|div|section)>/i.test(trimmed)) {
        fragments.push(htmlBuffer.join('\n'));
        htmlBuffer = [];
        inHtmlBlock = false;
      }
      continue;
    }

    if (/^<(table|div|section)\b/i.test(trimmed)) {
      flushLists();
      inHtmlBlock = true;
      htmlBuffer = [line];
      if (/<\/(table|div|section)>/i.test(trimmed)) {
        fragments.push(htmlBuffer.join('\n'));
        htmlBuffer = [];
        inHtmlBlock = false;
      }
      continue;
    }

    if (!trimmed) {
      flushLists();
      continue;
    }

    if (/^```/.test(trimmed) || /^---+$/.test(trimmed)) continue;

    if (trimmed.startsWith('# ')) {
      flushLists();
      fragments.push(`<h1>${inlineMarkdownToHtml(trimmed.slice(2).trim())}</h1>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushLists();
      fragments.push(`<h2>${inlineMarkdownToHtml(trimmed.slice(3).trim())}</h2>`);
      continue;
    }
    if (trimmed.startsWith('### ')) {
      flushLists();
      fragments.push(`<h3>${inlineMarkdownToHtml(trimmed.slice(4).trim())}</h3>`);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (numberedItems.length) {
        fragments.push(flushList(numberedItems, 'ol'));
        numberedItems = [];
      }
      bulletItems.push(inlineMarkdownToHtml(trimmed.slice(2).trim()));
      continue;
    }

    if (isNumberedListItem(trimmed)) {
      if (bulletItems.length) {
        fragments.push(flushList(bulletItems, 'ul'));
        bulletItems = [];
      }
      numberedItems.push(inlineMarkdownToHtml(trimmed.replace(/^\d+\.\s/, '')));
      continue;
    }

    flushLists();
    fragments.push(`<p>${inlineMarkdownToHtml(trimmed)}</p>`);
  }

  flushLists();
  if (htmlBuffer.length) fragments.push(htmlBuffer.join('\n'));

  return fragments;
}

function buildBriefHtmlDocument(markdown, { title = 'BRIEF ΕΡΓΑΣΙΩΝ', footer = '' } = {}) {
  const body = markdownToHtmlFragments(markdown).join('\n');
  const footerHtml = footer
    ? `<footer><p>${escapeHtml(footer)}</p></footer>`
    : '';

  return `<!DOCTYPE html>
<html lang="el">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f5f1;
      --card: #ffffff;
      --ink: #1c1917;
      --muted: #78716c;
      --line: #e7e5e4;
      --accent: #0f766e;
      --head: #134e4a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", Helvetica, Arial, sans-serif;
      background: linear-gradient(180deg, #efeae2 0%, var(--bg) 220px);
      color: var(--ink);
      line-height: 1.45;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 28px 28px 20px;
      box-shadow: 0 10px 30px rgba(28, 25, 23, 0.05);
    }
    h1, h2, h3 { color: var(--head); line-height: 1.25; }
    h1 { margin: 0 0 18px; font-size: 1.7rem; }
    h2 {
      margin: 28px 0 12px;
      padding-bottom: 6px;
      border-bottom: 2px solid #ccfbf1;
      font-size: 1.2rem;
    }
    h3 { margin: 18px 0 8px; font-size: 1.05rem; color: var(--accent); }
    p { margin: 0 0 10px; }
    ul, ol { margin: 0 0 12px; padding-left: 1.25rem; }
    li { margin: 0 0 6px; }
    code {
      font-family: "IBM Plex Mono", Menlo, Consolas, monospace;
      font-size: 0.92em;
      background: #f5f5f4;
      padding: 0.1em 0.35em;
      border-radius: 4px;
    }
    .commits-table-wrap {
      overflow-x: auto;
      margin: 8px 0 16px;
      border: 1px solid var(--line);
      border-radius: 10px;
    }
    table.commits {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
      background: #fff;
    }
    table.commits th,
    table.commits td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    table.commits th {
      background: #134e4a;
      color: #ecfdf5;
      font-weight: 600;
      white-space: nowrap;
    }
    table.commits tr:nth-child(even) td { background: #fafaf9; }
    table.commits td.commit-title { font-weight: 500; }
    table.commits td.commit-author { white-space: nowrap; color: #44403c; }
    table.commits td.commit-date { white-space: nowrap; color: var(--muted); }
    footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <main>
    <article class="card">
${body}
      ${footerHtml}
    </article>
  </main>
</body>
</html>
`;
}

function buildBriefHtmlBuffer(markdown, options = {}) {
  return Buffer.from(buildBriefHtmlDocument(markdown, options), 'utf8');
}

module.exports = {
  normalizeBriefMarkdown,
  escapeHtml,
  markdownToHtmlFragments,
  buildBriefHtmlDocument,
  buildBriefHtmlBuffer,
};
