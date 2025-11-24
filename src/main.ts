import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import Firecrawl from '@mendable/firecrawl-js';
import { config } from './config.js';
import {
  getResumeText,
  updateResumeText,
  applyWordReplacements,
  getRevisions,
  getRevisionContent,
} from './googleDrive.js';
import { getResumeReplacements } from './groqClient.js';
import type { VersionLogEntry } from './types.js';

const VERSION_LOG_FILE = 'resume_versions.json';

/**
 * Read version log from local JSON file
 */
function readVersionLog(): VersionLogEntry[] {
  if (!existsSync(VERSION_LOG_FILE)) {
    return [];
  }

  try {
    const content = readFileSync(VERSION_LOG_FILE, 'utf-8');
    return JSON.parse(content) as VersionLogEntry[];
  } catch (error) {
    console.error('Error reading version log:', error);
    return [];
  }
}

/**
 * Write version log to local JSON file
 */
function writeVersionLog(entries: VersionLogEntry[]): void {
  writeFileSync(VERSION_LOG_FILE, JSON.stringify(entries, null, 2) + '\n');
}

/**
 * Append entry to version log
 */
function appendVersionLog(entry: VersionLogEntry): void {
  const entries = readVersionLog();
  entries.push(entry);
  writeVersionLog(entries);
}

/**
 * Fetch job description from URL using Firecrawl API
 */
async function fetchJobDescriptionFromUrl(url: string): Promise<string> {
  // Validate URL format
  try {
    new URL(url);
  } catch (error) {
    throw new Error(`Invalid URL format: ${url}`);
  }

  // Check if API key is configured
  if (!config.FIRECRAWL_API_KEY) {
    throw new Error(
      'FIRECRAWL_API_KEY is required for URL scraping. Please add it to your .env file.'
    );
  }

  console.log(`Fetching job description from URL: ${url}`);
  
  try {
    const firecrawl = new Firecrawl({ apiKey: config.FIRECRAWL_API_KEY });
    const response = await firecrawl.scrapeUrl(url, {
      formats: ['markdown'],
    });

    // Check if response is an error
    if ('error' in response && response.error) {
      throw new Error(response.error);
    }

    // Check if response has success flag and markdown content
    if (!('success' in response) || !response.success) {
      throw new Error('Scrape operation was not successful');
    }

    if (!response.markdown) {
      throw new Error('No markdown content extracted from URL');
    }

    let markdownText = response.markdown.trim();
    
    // Clean up markdown: remove image references (not useful for JD analysis)
    markdownText = markdownText.replace(/!\[.*?\]\([^)]+\)/g, '');
    
    // Remove multiple consecutive newlines/whitespace
    markdownText = markdownText.replace(/\n{3,}/g, '\n\n').trim();
    
    if (markdownText.length === 0) {
      throw new Error('Extracted content is empty after cleaning');
    }

    console.log(`Successfully extracted ${markdownText.length} characters from URL`);
    return markdownText;
  } catch (error) {
    if (error instanceof Error) {
      // Provide clearer error messages
      if (error.message.includes('API key') || error.message.includes('401')) {
        throw new Error('Invalid or missing Firecrawl API key. Please check your FIRECRAWL_API_KEY in .env');
      }
      if (error.message.includes('404') || error.message.includes('not found')) {
        throw new Error(`URL not found: ${url}`);
      }
      if (error.message.includes('rate limit') || error.message.includes('429')) {
        throw new Error('Firecrawl API rate limit exceeded. Please try again later.');
      }
      throw new Error(`Failed to scrape URL: ${error.message}`);
    }
    throw new Error(`Failed to scrape URL: ${String(error)}`);
  }
}

/**
 * Get job description from command line args or file
 */
async function getJobDescription(): Promise<string> {
  const args = process.argv.slice(2);
  const jdIndex = args.indexOf('--jd');
  const jdFileIndex = args.indexOf('--jd-file');
  const jdUrlIndex = args.indexOf('--jd-url');

  if (jdUrlIndex !== -1 && args[jdUrlIndex + 1]) {
    const url = args[jdUrlIndex + 1];
    return await fetchJobDescriptionFromUrl(url);
  }

  if (jdIndex !== -1) {
    // Collect all words after --jd until next flag (starts with --) or end
    const jdWords: string[] = [];
    for (let i = jdIndex + 1; i < args.length; i++) {
      if (args[i]?.startsWith('--')) {
        break;
      }
      if (args[i]) {
        jdWords.push(args[i]);
      }
    }
    if (jdWords.length > 0) {
      return jdWords.join(' ');
    }
  }

  if (jdFileIndex !== -1 && args[jdFileIndex + 1]) {
    const filePath = args[jdFileIndex + 1];
    return readFileSync(filePath, 'utf-8');
  }

  // Interactive input via readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log('Paste job description (press Enter twice on empty line to finish):');
    const lines: string[] = [];
    let emptyLineCount = 0;

    rl.on('line', (line) => {
      if (line.trim() === '') {
        emptyLineCount++;
        if (emptyLineCount >= 2) {
          rl.close();
          resolve(lines.join('\n').trim());
        }
      } else {
        emptyLineCount = 0;
        lines.push(line);
      }
    });
  });
}

/**
 * Check if --dry-run flag is present
 */
function isDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

/**
 * Update resume with job description (PRESERVES FORMATTING)
 * Uses targeted word replacements via Google Docs API
 */
async function handleUpdate(): Promise<void> {
  const jobDescription = await getJobDescription();
  const dryRun = isDryRun();

  console.log('Job description:', jobDescription.substring(0, 150) + (jobDescription.length > 150 ? '...' : ''));
  console.log('\nFetching current resume...');
  const currentText = await getResumeText(config.RESUME_FILE_ID);

  const result = await getResumeReplacements(currentText, jobDescription);

  console.log('\n' + '='.repeat(60));
  console.log('SEMANTIC ALIGNMENTS:');
  console.log('='.repeat(60));
  result.replacements.forEach((r, i) => {
    console.log(`\n${i + 1}. ORIGINAL:`);
    console.log(`   "${r.original}"`);
    console.log(`   ALIGNED:`);
    console.log(`   "${r.replacement}"`);
  });

  console.log('\n' + '-'.repeat(60));
  console.log('ALIGNMENT STRATEGY:');
  result.changes.forEach((change, i) => {
    console.log(`  ${i + 1}. ${change}`);
  });
  console.log('-'.repeat(60));

  if (dryRun) {
    console.log('\n[DRY RUN] Would apply above alignments (formatting preserved).');
    return;
  }

  console.log('\nApplying replacements to Google Doc (formatting preserved)...');
  const appliedCount = await applyWordReplacements(config.RESUME_FILE_ID, result.replacements);
  console.log(`Applied ${appliedCount} text replacements.`);

  // Get latest revision after update
  const revisions = await getRevisions(config.RESUME_FILE_ID);
  const latestRevision = revisions[revisions.length - 1];

  const logEntry: VersionLogEntry = {
    revisionId: latestRevision.id,
    timestamp: latestRevision.modifiedTime,
    changes: result.changes,
    isRevert: false,
  };

  appendVersionLog(logEntry);
  console.log('Resume updated successfully. Revision ID:', latestRevision.id);
}

/**
 * List all versions with desync detection
 */
async function handleList(): Promise<void> {
  console.log('Fetching revisions from Google Drive...');
  const driveRevisions = await getRevisions(config.RESUME_FILE_ID);
  const localEntries = readVersionLog();

  // Build map of revision IDs from Drive
  const driveRevisionIds = new Set(driveRevisions.map((r) => r.id));

  // Check for desync
  const missingRevisions: string[] = [];
  const extraRevisions: string[] = [];

  localEntries.forEach((entry) => {
    if (!driveRevisionIds.has(entry.revisionId)) {
      extraRevisions.push(entry.revisionId);
    }
  });

  driveRevisions.forEach((rev) => {
    const found = localEntries.find((e) => e.revisionId === rev.id);
    if (!found && rev.id !== driveRevisions[0]?.id) {
      missingRevisions.push(rev.id);
    }
  });

  if (missingRevisions.length > 0 || extraRevisions.length > 0) {
    console.warn('\n⚠️  Desync detected!');
    if (missingRevisions.length > 0) {
      console.warn(`Missing in local log: ${missingRevisions.join(', ')}`);
    }
    if (extraRevisions.length > 0) {
      console.warn(`Extra in local log: ${extraRevisions.join(', ')}`);
    }
  }

  // Display table
  const tableData = localEntries.map((entry, index) => {
    const driveRev = driveRevisions.find((r) => r.id === entry.revisionId);
    return {
      Index: index,
      'Revision ID': entry.revisionId.substring(0, 8) + '...',
      Timestamp: new Date(entry.timestamp).toLocaleString(),
      'Job Title': entry.jobTitle || '-',
      Company: entry.company || '-',
      'Change Count': entry.changes.length,
      Type: entry.isRevert ? 'Revert' : 'Update',
      'In Drive': driveRev ? '✓' : '✗',
    };
  });

  console.log('\nVersion History:');
  console.table(tableData);
}

/**
 * Revert to a specific version
 */
async function handleRevert(): Promise<void> {
  const args = process.argv.slice(2);
  const revertArg = args.find((arg) => !arg.startsWith('--'));

  if (!revertArg) {
    console.error('Usage: npm start revert <index|revisionId>');
    process.exit(1);
  }

  const localEntries = readVersionLog();
  let targetEntry: VersionLogEntry | undefined;

  // Try as index first
  const index = parseInt(revertArg, 10);
  if (!isNaN(index) && index >= 0 && index < localEntries.length) {
    targetEntry = localEntries[index];
  } else {
    // Try as revision ID
    targetEntry = localEntries.find((e) => e.revisionId === revertArg);
  }

  if (!targetEntry) {
    console.error('Version not found. Use "list" to see available versions.');
    process.exit(1);
  }

  console.log(`Reverting to revision: ${targetEntry.revisionId}`);
  const oldContent = await getRevisionContent(
    config.RESUME_FILE_ID,
    targetEntry.revisionId
  );

  console.log('Restoring content...');
  await updateResumeText(config.RESUME_FILE_ID, oldContent);

  // Get latest revision after revert
  const revisions = await getRevisions(config.RESUME_FILE_ID);
  const latestRevision = revisions[revisions.length - 1];

  const logEntry: VersionLogEntry = {
    revisionId: latestRevision.id,
    timestamp: latestRevision.modifiedTime,
    changes: [`Reverted to revision ${targetEntry.revisionId}`],
    isRevert: true,
  };

  appendVersionLog(logEntry);
  console.log('Revert completed. New revision ID:', latestRevision.id);
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const mode = process.argv[2];

  try {
    switch (mode) {
      case 'update':
        await handleUpdate();
        break;
      case 'list':
        await handleList();
        break;
      case 'revert':
        await handleRevert();
        break;
      default:
        console.log('Usage:');
        console.log('  npm start -- update --jd "job description text" [--dry-run]');
        console.log('  npm start -- update --jd-file path/to/jd.txt [--dry-run]');
        console.log('  npm start -- update --jd-url "https://jobs.company.com/position" [--dry-run]');
        console.log('  npm start list');
        console.log('  npm start revert <index|revisionId>');
        console.log('');
        console.log('Note: Use -- after npm start to pass arguments correctly');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

