/**
 * Ingest vendor documentation from Discord attachments (zip, PDF, AAR, MD).
 * Downloads, unzips when needed, stores under data/vendor-ingest/, and indexes.
 */

const fs = require('fs');
const path = require('path');
const {
  extractZipArchive,
  walkIndexableFiles,
  isIndexableExtension,
} = require('./binary-doc-extract');
const {
  upsertPackage,
  packageFilesDir,
  getPackage,
  listPackages,
} = require('./vendor-ingest-store');

const ZIP_RE = /\.zip$/i;
const INGESTABLE_ATTACHMENT_RE = /\.(zip|pdf|aar|md|markdown|txt)$/i;

function isVendorIngestEnabled() {
  return String(process.env.KNOWLEDGE_VENDOR_INGEST_ENABLED || '').toLowerCase() === 'true';
}

function getVendorIngestChannels() {
  const explicit = String(process.env.KNOWLEDGE_VENDOR_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  return String(process.env.KNOWLEDGE_CAPTURE_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveVendorChannelId(message) {
  const channels = getVendorIngestChannels();
  if (!channels.length) return null;

  const channelId = message.channel?.id;
  const parentId = message.channel?.parentId || null;

  if (channelId && channels.includes(channelId)) return channelId;
  if (parentId && channels.includes(parentId)) return parentId;
  return null;
}

function maxAttachmentBytes() {
  return Number(process.env.KNOWLEDGE_VENDOR_MAX_MB || 25) * 1024 * 1024;
}

async function downloadAttachment(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

function safeFilename(name) {
  return String(name || 'file')
    .replace(/[^\w.\-() ]+/g, '_')
    .slice(0, 180);
}

function copyFileIntoPackage(srcPath, destRoot, relativePath) {
  const destPath = path.join(destRoot, relativePath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

async function materializeAttachment(buffer, attachmentName, filesDir) {
  fs.mkdirSync(filesDir, { recursive: true });
  const safeName = safeFilename(attachmentName);

  if (ZIP_RE.test(safeName)) {
    const extractDir = path.join(filesDir, '__extract');
    fs.mkdirSync(extractDir, { recursive: true });
    extractZipArchive(buffer, extractDir);

    const indexable = walkIndexableFiles(extractDir);
    for (const file of indexable) {
      copyFileIntoPackage(file.absolutePath, filesDir, file.relativePath);
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    return walkIndexableFiles(filesDir);
  }

  const ext = path.extname(safeName).toLowerCase();
  if (!isIndexableExtension(ext)) {
    throw new Error(`Unsupported attachment type: ${safeName}`);
  }

  const destPath = path.join(filesDir, safeName);
  fs.writeFileSync(destPath, buffer);
  return walkIndexableFiles(filesDir);
}

function buildPackageMeta(message, attachment, files) {
  const packageId = `${message.id}_${attachment.id}`;
  const channelName = message.channel?.name
    || message.channel?.parent?.name
    || message.channel?.id
    || '';

  return {
    id: packageId,
    messageId: message.id,
    messageUrl: message.url || '',
    channelId: message.channel?.id || '',
    channelName,
    authorId: message.author?.id || '',
    author: message.author?.username || '',
    attachmentId: attachment.id,
    attachmentName: attachment.name || 'attachment',
    attachmentUrl: attachment.url || '',
    ingestedAt: new Date().toISOString(),
    files: files.map((file) => ({
      relativePath: file.relativePath,
      ext: file.ext,
    })),
  };
}

async function ingestAttachment(message, attachment) {
  if (!INGESTABLE_ATTACHMENT_RE.test(attachment.name || '')) {
    return null;
  }

  if (attachment.size && attachment.size > maxAttachmentBytes()) {
    throw new Error(`Attachment too large (${attachment.size} bytes)`);
  }

  const packageId = `${message.id}_${attachment.id}`;
  const existing = getPackage(packageId);
  if (existing) {
    return { package: existing, skipped: true };
  }

  const buffer = await downloadAttachment(attachment.url);
  const filesDir = packageFilesDir(packageId);
  fs.rmSync(filesDir, { recursive: true, force: true });

  const files = await materializeAttachment(buffer, attachment.name, filesDir);
  if (!files.length) {
    throw new Error(`No indexable files found in ${attachment.name}`);
  }

  const meta = buildPackageMeta(message, attachment, files);
  upsertPackage(meta);

  const { indexVendorPackage } = require('./knowledge-indexer');
  const indexResult = await indexVendorPackage(packageId).catch((error) => {
    console.warn(`[vendor-ingest] index failed for ${packageId}: ${error.message}`);
    return null;
  });

  return { package: meta, skipped: false, indexResult };
}

async function processMessageAttachments(message) {
  if (!isVendorIngestEnabled()) return [];
  if (!message.attachments?.size) return [];

  const channelKey = resolveVendorChannelId(message);
  if (!channelKey) return [];

  const results = [];
  for (const attachment of message.attachments.values()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await ingestAttachment(message, attachment);
      if (result) results.push(result);
    } catch (error) {
      console.error(
        `[vendor-ingest] failed ${attachment.name} in #${message.channel?.name || message.channel?.id}:`,
        error.message,
      );
    }
  }
  return results;
}

function vendorIngestStatus() {
  if (!isVendorIngestEnabled()) return 'vendor ingest off';
  const channels = getVendorIngestChannels();
  const count = listPackages().length;
  return channels.length
    ? `vendor ingest ${channels.length} ch (${count} packages)`
    : 'vendor ingest on (no channels)';
}

module.exports = {
  isVendorIngestEnabled,
  getVendorIngestChannels,
  resolveVendorChannelId,
  processMessageAttachments,
  ingestAttachment,
  vendorIngestStatus,
};
