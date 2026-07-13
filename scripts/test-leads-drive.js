#!/usr/bin/env node
require('dotenv').config({ override: true });

const { google } = require('googleapis');
const { listLeadSpreadsheets, loadServiceAccountCredentials, getLeadsFolderId } = require('../lib/leads-drive');

async function main() {
  const creds = loadServiceAccountCredentials();
  if (!creds) {
    console.error('No service account configured.');
    process.exit(1);
  }

  console.log('Service account:', creds.client_email);
  console.log('Folder ID:', getLeadsFolderId());

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const shared = await drive.files.list({
    q: 'sharedWithMe = true',
    fields: 'files(id,name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  console.log('Items shared with SA:', shared.data.files?.length || 0);

  const files = await listLeadSpreadsheets();
  console.log('Spreadsheets found:', files.length);
  files.forEach((f) => console.log(`- ${f.name}${f.folderPath ? ` (${f.folderPath})` : ''}`));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
