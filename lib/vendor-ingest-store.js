/**
 * Local store for vendor files ingested from Discord attachments.
 * Persisted under data/vendor-ingest/ (gitignored).
 */

const fs = require('fs');
const path = require('path');
const {
  extractTextFromFile,
  titleFromFilename,
  walkIndexableFiles,
} = require('./binary-doc-extract');

const STORE_DIR = path.join(__dirname, '..', 'data', 'vendor-ingest');
const MANIFEST_PATH = path.join(STORE_DIR, 'manifest.json');
const PACKAGES_DIR = path.join(STORE_DIR, 'packages');

function ensureStore() {
  fs.mkdirSync(PACKAGES_DIR, { recursive: true });
  if (!fs.existsSync(MANIFEST_PATH)) {
    fs.writeFileSync(MANIFEST_PATH, '[]\n', 'utf8');
  }
}

function readManifest() {
  ensureStore();
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifest(entries) {
  ensureStore();
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function packageDir(packageId) {
  return path.join(PACKAGES_DIR, packageId);
}

function packageFilesDir(packageId) {
  return path.join(packageDir(packageId), 'files');
}

function getPackage(packageId) {
  return readManifest().find((entry) => entry.id === packageId) || null;
}

function listPackages() {
  return readManifest().sort((a, b) => String(b.ingestedAt).localeCompare(String(a.ingestedAt)));
}

function upsertPackage(meta) {
  const manifest = readManifest();
  const index = manifest.findIndex((entry) => entry.id === meta.id);
  if (index >= 0) manifest[index] = meta;
  else manifest.unshift(meta);
  writeManifest(manifest);
  return meta;
}

function savePackageFiles(packageId, filesMeta) {
  const metaPath = path.join(packageDir(packageId), 'meta.json');
  fs.mkdirSync(packageDir(packageId), { recursive: true });
  fs.writeFileSync(metaPath, `${JSON.stringify(filesMeta, null, 2)}\n`, 'utf8');
}

function loadPackageMeta(packageId) {
  const metaPath = path.join(packageDir(packageId), 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

async function buildVendorItemsFromStore() {
  const items = [];

  for (const pkg of listPackages()) {
    const filesDir = packageFilesDir(pkg.id);
    if (!fs.existsSync(filesDir)) continue;

    for (const file of walkIndexableFiles(filesDir)) {
      try {
        const text = await extractTextFromFile(file.absolutePath);
        if (!text) continue;

        const title = `${titleFromFilename(file.relativePath)} (${pkg.attachmentName})`;
        items.push({
          sourcePath: `discord-vendor/${pkg.id}/${file.relativePath}`,
          title,
          url: pkg.messageUrl || '',
          timestamp: pkg.ingestedAt || '',
          sourceType: 'vendor',
          text: [
            title,
            `Source: Discord #${pkg.channelName || pkg.channelId}`,
            `Archive: ${pkg.attachmentName}`,
            '',
            text,
          ].join('\n'),
        });
      } catch (error) {
        console.warn(`[vendor-ingest] skip ${pkg.id}/${file.relativePath}: ${error.message}`);
      }
    }
  }

  return items;
}

module.exports = {
  STORE_DIR,
  readManifest,
  listPackages,
  getPackage,
  upsertPackage,
  savePackageFiles,
  loadPackageMeta,
  packageDir,
  packageFilesDir,
  buildVendorItemsFromStore,
};
