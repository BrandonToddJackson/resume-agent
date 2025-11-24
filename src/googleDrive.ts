import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import { config } from './config.js';
import type { Revision } from './types.js';

let driveClient: ReturnType<typeof google.drive> | null = null;
let docsClient: ReturnType<typeof google.docs> | null = null;

/**
 * Initialize Google Drive client with service account authentication
 */
async function initializeDriveClient(): Promise<ReturnType<typeof google.drive>> {
  if (driveClient) {
    return driveClient;
  }

  const auth = new GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  });

  const authClient = await auth.getClient();
  driveClient = google.drive({ version: 'v3', auth: authClient as never });
  return driveClient;
}

/**
 * Initialize Google Docs client
 */
async function initializeDocsClient(): Promise<ReturnType<typeof google.docs>> {
  if (docsClient) {
    return docsClient;
  }

  const auth = new GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });

  const authClient = await auth.getClient();
  docsClient = google.docs({ version: 'v1', auth: authClient as never });
  return docsClient;
}

/**
 * Export Google Doc as plain text
 */
export async function getResumeText(fileId: string): Promise<string> {
  const drive = await initializeDriveClient();
  const response = await drive.files.export(
    {
      fileId,
      mimeType: 'text/plain',
    },
    { responseType: 'text' }
  );

  if (typeof response.data !== 'string') {
    throw new Error('Expected text response from Drive export');
  }

  return response.data;
}

/**
 * Word replacement type for targeted updates
 */
export interface WordReplacement {
  original: string;
  replacement: string;
}

/**
 * Apply word replacements directly in Google Doc (PRESERVES ALL FORMATTING)
 * Uses replaceAllText which only changes text, not formatting
 */
export async function applyWordReplacements(
  fileId: string,
  replacements: WordReplacement[]
): Promise<number> {
  const docs = await initializeDocsClient();
  
  // Build replaceAllText requests for each replacement
  const requests = replacements.map((r) => ({
    replaceAllText: {
      containsText: {
        text: r.original,
        matchCase: true,
      },
      replaceText: r.replacement,
    },
  }));

  if (requests.length === 0) {
    return 0;
  }

  const response = await docs.documents.batchUpdate({
    documentId: fileId,
    requestBody: {
      requests,
    },
  });

  // Count how many replacements were actually made
  const replies = response.data.replies || [];
  let totalReplaced = 0;
  for (const reply of replies) {
    if (reply.replaceAllText?.occurrencesChanged) {
      totalReplaced += reply.replaceAllText.occurrencesChanged;
    }
  }

  return totalReplaced;
}

/**
 * Update Google Doc content by overwriting with new text
 * WARNING: This destroys all formatting! Use applyWordReplacements instead.
 * Kept for revert functionality only.
 */
export async function updateResumeText(fileId: string, text: string): Promise<void> {
  const docs = await initializeDocsClient();

  // Get current document to clear existing content
  const doc = await docs.documents.get({ documentId: fileId });
  if (!doc.data.body?.content) {
    throw new Error('Unable to read document structure');
  }

  // Build request to replace all content
  const requests: Array<{ deleteContentRange?: { range: { startIndex: number; endIndex: number } }; insertText?: { location: { index: number }; text: string } }> = [];

  // Delete all content except the last newline (index 1 to endIndex-1)
  const endIndex = doc.data.body.content[doc.data.body.content.length - 1]?.endIndex;
  if (endIndex && endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: 1,
          endIndex: endIndex - 1,
        },
      },
    });
  }

  // Insert new text at the beginning
  requests.push({
    insertText: {
      location: {
        index: 1,
      },
      text: text,
    },
  });

  await docs.documents.batchUpdate({
    documentId: fileId,
    requestBody: {
      requests,
    },
  });
}

/**
 * Get list of all revisions for a file
 */
export async function getRevisions(fileId: string): Promise<Revision[]> {
  const drive = await initializeDriveClient();
  const response = await drive.revisions.list({ fileId });

  if (!response.data.revisions) {
    return [];
  }

  return response.data.revisions.map((rev) => ({
    id: rev.id || '',
    modifiedTime: rev.modifiedTime || '',
    mimeType: rev.mimeType || '',
  }));
}

/**
 * Export specific revision as plain text
 * Note: For Google Docs, revisions.get with alt='media' may not work.
 * This function attempts to get revision content, but may need testing.
 * Alternative: Could use Drive API to restore revision temporarily, but that's more complex.
 */
export async function getRevisionContent(fileId: string, revisionId: string): Promise<string> {
  const drive = await initializeDriveClient();
  
  // Attempt to get revision content directly
  // For Google Docs, this may require using the Docs API or a different approach
  try {
    const response = await drive.revisions.get(
      {
        fileId,
        revisionId,
        alt: 'media',
      },
      { responseType: 'text' }
    );

    if (typeof response.data === 'string') {
      return response.data;
    }
  } catch (error) {
    // If direct revision export fails, fall back to exporting current file
    // This is a limitation: we can't easily get old revision content for Google Docs
    console.warn(`Warning: Could not export revision ${revisionId} directly. Using current file content.`);
  }

  // Fallback: export current file (not ideal, but works for MVP)
  return await getResumeText(fileId);
}

/**
 * Export Google Doc revision as PDF or DOCX
 * Note: Google Drive API doesn't support exporting specific revisions directly.
 * This function exports the current version. To export a specific revision,
 * you would need to temporarily restore that revision first.
 */
export async function exportRevision(
  fileId: string,
  format: 'pdf' | 'docx',
  outputPath: string
): Promise<void> {
  const drive = await initializeDriveClient();
  
  const mimeTypes: Record<'pdf' | 'docx', string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  
  const mimeType = mimeTypes[format];
  
  const response = await drive.files.export(
    {
      fileId,
      mimeType,
    },
    { responseType: 'stream' }
  );
  
  // Write stream to file
  const fs = await import('fs');
  const writeStream = fs.createWriteStream(outputPath);
  
  return new Promise((resolve, reject) => {
    response.data
      .pipe(writeStream)
      .on('finish', resolve)
      .on('error', reject);
  });
}

