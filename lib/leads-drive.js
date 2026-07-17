/**
 * Read-only Google Drive access for /leads — lists spreadsheets in a folder.
 * Never writes, moves, or deletes anything on Drive.
 */

const { google } = require('googleapis');
const fs = require('fs');

const DEFAULT_FOLDER_ID = '1ro5kXfGnc3VZz0Mg41DqyEN49CoQc0nF';
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const SPREADSHEET_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.google-apps.spreadsheet',
]);

function getLeadsFolderId() {
  return process.env.LEADS_DRIVE_FOLDER_ID || DEFAULT_FOLDER_ID;
}

function loadServiceAccountCredentials() {
  const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  if (jsonPath && fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }

  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inlineJson?.trim()) {
    return JSON.parse(inlineJson);
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (email && privateKey) {
    return { client_email: email, private_key: privateKey };
  }

  return null;
}

function isLeadsDriveConfigured() {
  return Boolean(loadServiceAccountCredentials());
}

function createDriveClient() {
  const credentials = loadServiceAccountCredentials();
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error(
      'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON_PATH '
      + 'or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.',
    );
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [DRIVE_READONLY_SCOPE],
  });

  return google.drive({ version: 'v3', auth });
}

function normalizeDriveFile(file, folderPath = '') {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime || '',
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    folderPath,
  };
}

function isSpreadsheetMime(mimeType) {
  return SPREADSHEET_MIME_TYPES.has(mimeType);
}

async function listChildren(drive, folderId, pageToken) {
  return drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink,shortcutDetails)',
    pageSize: 100,
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
}

async function verifyFolderAccess(drive, folderId) {
  try {
    const meta = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType,driveId',
      supportsAllDrives: true,
    });
    return meta.data;
  } catch (error) {
    const credentials = loadServiceAccountCredentials();
    const email = credentials?.client_email || 'service-account';
    throw new Error(
      `Cannot access folder ${folderId}. The service account (${email}) does not see this folder.\n`
      + 'If the folder lives in a **Shared drive**, add the service account as a **member of the Shared drive** '
      + '(not only via Share on the folder).\n'
      + 'Otherwise share the folder with the service account email as Viewer, or use a copy in your personal My Drive.',
    );
  }
}

/**
 * Recursively list spreadsheet files under a folder (read-only).
 */
async function listLeadSpreadsheets({
  folderId = getLeadsFolderId(),
  recursive = process.env.LEADS_DRIVE_RECURSIVE !== 'false',
} = {}) {
  const drive = createDriveClient();
  await verifyFolderAccess(drive, folderId);
  const results = [];
  const visited = new Set();

  async function walk(currentFolderId, folderPath) {
    if (visited.has(currentFolderId)) return;
    visited.add(currentFolderId);

    let pageToken;
    do {
      const response = await listChildren(drive, currentFolderId, pageToken);
      const files = response.data.files || [];

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.shortcut' && file.shortcutDetails?.targetId) {
          if (isSpreadsheetMime(file.shortcutDetails.targetMimeType)) {
            results.push(normalizeDriveFile({
              id: file.shortcutDetails.targetId,
              name: file.name,
              mimeType: file.shortcutDetails.targetMimeType,
              modifiedTime: file.modifiedTime,
              webViewLink: `https://drive.google.com/file/d/${file.shortcutDetails.targetId}/view`,
            }, folderPath));
          }
          continue;
        }

        if (isSpreadsheetMime(file.mimeType)) {
          results.push(normalizeDriveFile(file, folderPath));
          continue;
        }

        if (recursive && file.mimeType === 'application/vnd.google-apps.folder') {
          const childPath = folderPath ? `${folderPath}/${file.name}` : file.name;
          await walk(file.id, childPath);
        }
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);
  }

  await walk(folderId, '');
  results.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
  return results;
}

const MAX_DOWNLOAD_BYTES = Number(process.env.LEADS_DRIVE_MAX_DOWNLOAD_BYTES || 15 * 1024 * 1024);
const GOOGLE_SHEET_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function getFileSize(drive, fileId) {
  const meta = await drive.files.get({
    fileId,
    fields: 'size,mimeType',
    supportsAllDrives: true,
  });
  return meta.data;
}

/**
 * Download spreadsheet bytes read-only (.xlsx, .xls, or Google Sheet exported as xlsx).
 */
async function downloadSpreadsheetBuffer(file) {
  const drive = createDriveClient();
  const meta = await getFileSize(drive, file.id);
  const size = Number(meta.size || 0);
  if (size > 0 && size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`file too large (${Math.round(size / 1024 / 1024)}MB)`);
  }

  if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const response = await drive.files.export(
      { fileId: file.id, mimeType: GOOGLE_SHEET_EXPORT_MIME },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(response.data);
  }

  const response = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(response.data);
}

module.exports = {
  DEFAULT_FOLDER_ID,
  getLeadsFolderId,
  isLeadsDriveConfigured,
  loadServiceAccountCredentials,
  verifyFolderAccess,
  listLeadSpreadsheets,
  downloadSpreadsheetBuffer,
};
