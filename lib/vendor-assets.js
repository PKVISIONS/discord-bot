/**
 * List and extract text from vendor/ assets (PDF, AAR) in EmblemTameiaki-Knowledge.
 * Source files stay binary in git; text is extracted at index time only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const pdfParse = require('pdf-parse');
const {
  resolveKnowledgeRoot,
  getKnowledgeBranch,
} = require('./knowledge-base');

const VENDOR_PREFIX = 'vendor/';
const VENDOR_EXTENSIONS = new Set(['.pdf', '.aar']);

/** @type {{ root: string, branch: string|null, sha: string, assets: object[] }|null} */
let cache = null;

function gitExec(knowledgeRoot, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  try {
    return execFileSync('git', ['-C', knowledgeRoot, ...args], {
      encoding: encoding === 'buffer' ? undefined : encoding,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function maybeFetchBranch(knowledgeRoot, branch) {
  if (process.env.KNOWLEDGE_REPO_FETCH !== 'true') return;
  try {
    gitExec(knowledgeRoot, ['fetch', 'origin', branch, '--quiet']);
  } catch {
    // non-fatal
  }
}

function resolveGitRef(knowledgeRoot, branch) {
  maybeFetchBranch(knowledgeRoot, branch);
  const candidates = [`origin/${branch}`, branch];
  for (const ref of candidates) {
    const sha = gitExec(knowledgeRoot, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
    if (sha) return { ref, sha: String(sha).trim() };
  }
  throw new Error(`Knowledge branch "${branch}" not found in ${knowledgeRoot}.`);
}

function titleFromVendorPath(relativePath) {
  const base = path.basename(relativePath, path.extname(relativePath));
  const cleaned = base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const dir = path.dirname(relativePath).replace(/^vendor\//, '').split('/')[0];
  if (dir && dir !== '.') {
    return `${dir.charAt(0).toUpperCase()}${dir.slice(1)} — ${cleaned}`;
  }
  return cleaned;
}

function walkVendorFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkVendorFiles(full, base));
    } else if (VENDOR_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const relativePath = path.relative(base, full).replace(/\\/g, '/');
      files.push({
        relativePath: `${VENDOR_PREFIX}${relativePath}`,
        absolutePath: full,
        ext: path.extname(entry.name).toLowerCase(),
      });
    }
  }

  return files;
}

function listVendorFilesFromGit(knowledgeRoot, gitRef) {
  const output = gitExec(knowledgeRoot, ['ls-tree', '-r', '-z', '--name-only', gitRef, '--', 'vendor']);
  if (!output) return [];

  return String(output)
    .split('\0')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(VENDOR_PREFIX))
    .filter((line) => VENDOR_EXTENSIONS.has(path.extname(line).toLowerCase()))
    .map((repoPath) => ({
      relativePath: repoPath,
      repoPath,
      ext: path.extname(repoPath).toLowerCase(),
    }));
}

function readBinaryFromFilesystem(absolutePath) {
  return fs.readFileSync(absolutePath);
}

function readBinaryFromGit(knowledgeRoot, gitRef, repoPath) {
  return gitExec(knowledgeRoot, ['show', `${gitRef}:${repoPath}`], { encoding: 'buffer' });
}

async function extractPdfText(buffer) {
  const parsed = await pdfParse(buffer);
  return String(parsed.text || '').trim();
}

function extractAarText(buffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-aar-'));
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

async function extractVendorText(buffer, ext) {
  if (ext === '.pdf') return extractPdfText(buffer);
  if (ext === '.aar') return extractAarText(buffer);
  return '';
}

function loadVendorAssetsFromFilesystem(knowledgeRoot) {
  const vendorDir = path.join(knowledgeRoot, 'vendor');
  if (!fs.existsSync(vendorDir)) {
    return { sha: '0', branch: null, assets: [] };
  }

  const mtime = fs.statSync(vendorDir).mtimeMs;
  const files = walkVendorFiles(vendorDir, vendorDir);

  const assets = files.map((file) => ({
    relativePath: file.relativePath,
    title: titleFromVendorPath(file.relativePath),
    ext: file.ext,
    read: () => readBinaryFromFilesystem(file.absolutePath),
  }));

  return { sha: String(mtime), branch: null, assets };
}

function loadVendorAssetsFromGit(knowledgeRoot, branch) {
  const { ref, sha } = resolveGitRef(knowledgeRoot, branch);
  const files = listVendorFilesFromGit(knowledgeRoot, ref);

  const assets = files.map((file) => ({
    relativePath: file.relativePath,
    title: titleFromVendorPath(file.relativePath),
    ext: file.ext,
    read: () => readBinaryFromGit(knowledgeRoot, ref, file.repoPath),
  }));

  return { sha, branch: ref, assets };
}

function listVendorAssets(knowledgeRoot) {
  const branch = getKnowledgeBranch();

  if (branch) {
    const loaded = loadVendorAssetsFromGit(knowledgeRoot, branch);
    if (cache
      && cache.root === knowledgeRoot
      && cache.branch === loaded.branch
      && cache.sha === loaded.sha) {
      return cache.assets;
    }
    cache = { root: knowledgeRoot, branch: loaded.branch, sha: loaded.sha, assets: loaded.assets };
    return loaded.assets;
  }

  const loaded = loadVendorAssetsFromFilesystem(knowledgeRoot);
  const cacheKey = `fs:${loaded.sha}`;
  if (cache && cache.root === knowledgeRoot && cache.sha === cacheKey) {
    return cache.assets;
  }
  cache = { root: knowledgeRoot, branch: null, sha: cacheKey, assets: loaded.assets };
  return loaded.assets;
}

async function buildVendorItems(repoFullName) {
  const root = resolveKnowledgeRoot(repoFullName);
  if (!root) return [];

  const assets = listVendorAssets(root);
  const items = [];

  for (const asset of assets) {
    try {
      const buffer = asset.read();
      const text = await extractVendorText(buffer, asset.ext);
      if (!text) continue;

      items.push({
        sourcePath: asset.relativePath,
        title: asset.title,
        sourceType: 'vendor',
        text: `${asset.title}\n\n${text}`,
      });
    } catch (error) {
      console.warn(`[vendor] skip ${asset.relativePath}: ${error.message}`);
    }
  }

  return items;
}

module.exports = {
  listVendorAssets,
  buildVendorItems,
  extractVendorText,
  titleFromVendorPath,
  VENDOR_PREFIX,
};
