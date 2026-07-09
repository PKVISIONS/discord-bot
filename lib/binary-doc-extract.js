/**
 * Extract searchable text from binary vendor documents (PDF, AAR, etc.).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const pdfParse = require('pdf-parse');

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const BINARY_EXTENSIONS = new Set(['.pdf', '.aar']);

function isIndexableExtension(ext) {
  const normalized = String(ext || '').toLowerCase();
  return TEXT_EXTENSIONS.has(normalized) || BINARY_EXTENSIONS.has(normalized);
}

function titleFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function extractPdfText(buffer) {
  const parsed = await pdfParse(buffer);
  return String(parsed.text || '').trim();
}

function extractAarText(buffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-aar-'));
  const aarPath = path.join(tmpDir, 'lib.aar');

  try {
    fs.writeFileSync(aarPath, buffer);
    const parts = [];

    for (const entry of ['AndroidManifest.xml', 'R.txt', 'proguard.txt']) {
      try {
        const text = execFileSync('unzip', ['-p', aarPath, entry], {
          encoding: 'utf8',
          maxBuffer: 5 * 1024 * 1024,
        }).trim();
        if (text) parts.push(`--- ${entry} ---\n${text}`);
      } catch {
        // entry may be missing
      }
    }

    try {
      const listing = execFileSync('unzip', ['-l', aarPath], { encoding: 'utf8' });
      const aidl = listing
        .split('\n')
        .filter((line) => line.includes('.aidl'))
        .map((line) => line.trim())
        .filter(Boolean);
      if (aidl.length) {
        parts.push(`--- AIDL interfaces ---\n${aidl.join('\n')}`);
      }
    } catch {
      // ignore
    }

    return parts.join('\n\n').trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractTextFromFile(absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return fs.readFileSync(absolutePath, 'utf8').trim();
  }
  const buffer = fs.readFileSync(absolutePath);
  return extractTextFromBuffer(buffer, ext);
}

async function extractTextFromBuffer(buffer, ext) {
  const normalized = String(ext || '').toLowerCase();
  if (TEXT_EXTENSIONS.has(normalized)) {
    return buffer.toString('utf8').trim();
  }
  if (normalized === '.pdf') return extractPdfText(buffer);
  if (normalized === '.aar') return extractAarText(buffer);
  return '';
}

function extractZipArchive(zipBuffer, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, '__archive.zip');
  fs.writeFileSync(zipPath, zipBuffer);
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], {
      maxBuffer: 20 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

function walkIndexableFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    if (entry.isDirectory()) {
      files.push(...walkIndexableFiles(full, base));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!isIndexableExtension(ext)) continue;
    files.push({
      relativePath: path.relative(base, full).replace(/\\/g, '/'),
      absolutePath: full,
      ext,
    });
  }
  return files;
}

module.exports = {
  isIndexableExtension,
  titleFromFilename,
  extractTextFromFile,
  extractTextFromBuffer,
  extractZipArchive,
  walkIndexableFiles,
  TEXT_EXTENSIONS,
  BINARY_EXTENSIONS,
};
