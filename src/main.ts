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
  exportRevision,
} from './googleDrive.js';
import { getResumeReplacements } from './groqClient.js';
import type { VersionLogEntry } from './types.js';
import { monitorCompanies, readJobQueue, writeJobQueue } from './monitor.js';
import { sourceJobOpportunities } from './jobSource.js';

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
 * Returns both the JD text and the source URL (if from URL)
 */
async function getJobDescription(): Promise<{ jd: string; url?: string }> {
  const args = process.argv.slice(2);
  const jdIndex = args.indexOf('--jd');
  const jdFileIndex = args.indexOf('--jd-file');
  const jdUrlIndex = args.indexOf('--jd-url');

  if (jdUrlIndex !== -1 && args[jdUrlIndex + 1]) {
    const url = args[jdUrlIndex + 1];
    const jd = await fetchJobDescriptionFromUrl(url);
    return { jd, url };
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
      return { jd: jdWords.join(' ') };
    }
  }

  if (jdFileIndex !== -1 && args[jdFileIndex + 1]) {
    const filePath = args[jdFileIndex + 1];
    return { jd: readFileSync(filePath, 'utf-8') };
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
          resolve({ jd: lines.join('\n').trim() });
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

// Subdomains that are NOT company names
const SKIP_SUBDOMAINS = ['careers', 'jobs', 'job-boards', 'work', 'boards', 'apply', 'hire', 'www'];
// Known job board domains where company is in path, not hostname
const JOB_BOARD_DOMAINS = ['greenhouse.io', 'lever.co', 'workday.com', 'icims.com', 'smartrecruiters.com'];

/**
 * Extract company and job title from URL using first-principles approach
 */
function extractMetadataFromUrl(url: string): { company?: string; jobTitle?: string } {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathParts = urlObj.pathname.split('/').filter(p => p && p.length > 1);
    
    let company: string | undefined;
    let jobTitle: string | undefined;
    
    // Check if this is a job board (company in path, not hostname)
    const isJobBoard = JOB_BOARD_DOMAINS.some(domain => hostname.includes(domain));
    
    if (isJobBoard) {
      // For job boards, don't extract company from URL path (unreliable)
      // Company should be extracted from JD content instead
      company = undefined;
    } else {
      // Extract company from hostname, skipping common subdomains
      const domainParts = hostname.replace(/^www\./, '').split('.');
      for (const part of domainParts) {
        if (!SKIP_SUBDOMAINS.includes(part) && part.length > 2) {
          company = part.charAt(0).toUpperCase() + part.slice(1);
          break;
        }
      }
    }
    
    // Extract job title from last meaningful path segment
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.length > 5 && !lastPart.match(/^\d+$/)) {
      // Clean up URL encoding and dashes
      const cleaned = decodeURIComponent(lastPart).split(/[-_]/).filter(w => w.length > 1);
      if (cleaned.length > 1) {
        jobTitle = cleaned.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }
    
    return { company, jobTitle };
  } catch {
    return {};
  }
}

/**
 * Extract company and job title from job description content
 */
function extractMetadataFromJD(jobDescription: string): { company?: string; jobTitle?: string } {
  // Find job title: first H1 header that looks like a job title
  let jobTitle: string | undefined;
  const h1Match = jobDescription.match(/^#\s+([^#\n]+)$/m);
  if (h1Match && h1Match[1]) {
    const title = h1Match[1].trim();
    // Skip if it looks like navigation or generic text
    if (title.length > 5 && title.length < 100 && !title.toLowerCase().includes('back to')) {
      jobTitle = title;
    }
  }
  
  // Find company name from common patterns
  const companyPatterns = [
    /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+Logo/i, // "Company Logo" pattern
    /\[([A-Z][a-zA-Z\s&]+?)\s+Logo\]/i, // [Company Logo] pattern
    /at\s+([A-Z][a-zA-Z\s&]+?)(?:\s|$|,|\.)/,
    /([A-Z][a-zA-Z\s&]+?)\s+is\s+(?:hiring|looking|seeking)/i,
    /Join\s+([A-Z][a-zA-Z\s&]+?)(?:\s|$|,|\.)/i,
    /About\s+([A-Z][a-zA-Z\s&]+?)(?:\s|$|,|\.)/i,
  ];
  
  let company: string | undefined;
  for (const pattern of companyPatterns) {
    const match = jobDescription.match(pattern);
    if (match && match[1] && match[1].length > 2 && match[1].length < 50) {
      company = match[1].trim();
      break;
    }
  }
  
  return { company, jobTitle };
}

/**
 * Get metadata from command line flags or auto-extract
 */
function getMetadata(jobDescription: string, jobUrl?: string): {
  company?: string;
  jobTitle?: string;
  jobUrl?: string;
} {
  const args = process.argv.slice(2);
  
  // Check for explicit flags
  const companyIndex = args.indexOf('--company');
  const jobTitleIndex = args.indexOf('--job-title');
  
  let company = companyIndex !== -1 && args[companyIndex + 1] 
    ? args[companyIndex + 1] 
    : undefined;
  let jobTitle = jobTitleIndex !== -1 && args[jobTitleIndex + 1]
    ? args[jobTitleIndex + 1]
    : undefined;
  
  // Auto-extract if not provided
  if (jobUrl && (!company || !jobTitle)) {
    const urlMetadata = extractMetadataFromUrl(jobUrl);
    company = company || urlMetadata.company;
    jobTitle = jobTitle || urlMetadata.jobTitle;
  }
  
  // Try extracting from JD content if still missing
  if (!company || !jobTitle) {
    const jdMetadata = extractMetadataFromJD(jobDescription);
    company = company || jdMetadata.company;
    jobTitle = jobTitle || jdMetadata.jobTitle;
  }
  
  return { company, jobTitle, jobUrl };
}

/**
 * Core update logic - can be called programmatically or from CLI
 */
async function performUpdate(
  jobDescription: string,
  _jobUrl: string | undefined,
  metadata: { company?: string; jobTitle?: string; jobUrl?: string },
  dryRun: boolean
): Promise<{ success: boolean; revisionId?: string; error?: string }> {

  try {
    if (metadata.company || metadata.jobTitle) {
      console.log('Metadata:');
      if (metadata.company) console.log(`  Company: ${metadata.company}`);
      if (metadata.jobTitle) console.log(`  Job Title: ${metadata.jobTitle}`);
      if (metadata.jobUrl) console.log(`  URL: ${metadata.jobUrl}`);
      console.log('');
    }

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
    return { success: true };
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
    company: metadata.company,
    jobTitle: metadata.jobTitle,
    jobUrl: metadata.jobUrl,
    changes: result.changes,
    isRevert: false,
  };

    appendVersionLog(logEntry);
    console.log('Resume updated successfully. Revision ID:', latestRevision.id);
    if (metadata.company || metadata.jobTitle) {
      console.log(`Tagged as: ${metadata.company || 'Unknown'} - ${metadata.jobTitle || 'Untitled'}`);
    }
    
    return { success: true, revisionId: latestRevision.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error processing update: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Update resume with job description (PRESERVES FORMATTING)
 * Uses targeted word replacements via Google Docs API
 */
async function handleUpdate(): Promise<void> {
  const { jd: jobDescription, url: jobUrl } = await getJobDescription();
  const dryRun = isDryRun();
  const metadata = getMetadata(jobDescription, jobUrl);
  
  const result = await performUpdate(jobDescription, jobUrl, metadata, dryRun);
  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Process batch of job URLs
 */
async function handleBatch(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = isDryRun();
  
  // Find --urls flag or --file flag
  const urlsIndex = args.indexOf('--urls');
  const fileIndex = args.indexOf('--file');
  
  let urls: string[] = [];
  
  if (fileIndex !== -1 && args[fileIndex + 1]) {
    // Read URLs from file (one per line)
    const filePath = args[fileIndex + 1];
    const fileContent = readFileSync(filePath, 'utf-8');
    urls = fileContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.startsWith('http'));
  } else if (urlsIndex !== -1) {
    // Collect URLs from command line
    for (let i = urlsIndex + 1; i < args.length; i++) {
      if (args[i]?.startsWith('--')) {
        break;
      }
      if (args[i] && args[i].startsWith('http')) {
        urls.push(args[i]);
      }
    }
  } else {
    console.error('Usage: npm start batch --urls "url1 url2 url3"');
    console.error('   or: npm start batch --file path/to/urls.txt');
    process.exit(1);
  }
  
  if (urls.length === 0) {
    console.error('No valid URLs found');
    process.exit(1);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`BATCH PROCESSING: ${urls.length} job URL(s)`);
  console.log(`${'='.repeat(60)}\n`);
  
  const results: Array<{ url: string; success: boolean; revisionId?: string; error?: string }> = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);
    console.log('-'.repeat(60));
    
    try {
      // Fetch job description from URL
      const jobDescription = await fetchJobDescriptionFromUrl(url);
      
      // Extract metadata
      const metadata = getMetadata(jobDescription, url);
      
      // Perform update
      const result = await performUpdate(jobDescription, url, metadata, dryRun);
      
      results.push({
        url,
        success: result.success,
        revisionId: result.revisionId,
        error: result.error,
      });
      
      if (result.success) {
        console.log(`✓ Successfully processed: ${url}`);
      } else {
        console.log(`✗ Failed: ${url} - ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Error processing ${url}: ${errorMessage}`);
      results.push({
        url,
        success: false,
        error: errorMessage,
      });
    }
    
    // Add separator between jobs (except last one)
    if (i < urls.length - 1) {
      console.log('\n');
    }
  }
  
  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('BATCH PROCESSING SUMMARY');
  console.log(`${'='.repeat(60)}`);
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`Total: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\nFailed URLs:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.url}: ${r.error}`);
    });
  }
  
  if (failed > 0 && successful === 0) {
    process.exit(1);
  }
}

/**
 * List all versions with desync detection and filtering
 */
async function handleList(): Promise<void> {
  const args = process.argv.slice(2);
  let companyFilter: string | undefined;
  let jobFilter: string | undefined;
  
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--company' || args[i] === '-c') && args[i + 1]) {
      companyFilter = args[i + 1];
    }
    if ((args[i] === '--job' || args[i] === '--job-title' || args[i] === '-j') && args[i + 1]) {
      jobFilter = args[i + 1];
    }
  }

  console.log('Fetching revisions from Google Drive...');
  const driveRevisions = await getRevisions(config.RESUME_FILE_ID);
  let localEntries = readVersionLog();

  // Apply filters
  if (companyFilter) {
    localEntries = localEntries.filter((entry) =>
      entry.company?.toLowerCase().includes(companyFilter.toLowerCase())
    );
  }
  if (jobFilter) {
    localEntries = localEntries.filter((entry) =>
      entry.jobTitle?.toLowerCase().includes(jobFilter.toLowerCase())
    );
  }

  // Build map of revision IDs from Drive
  const driveRevisionIds = new Set(driveRevisions.map((r) => r.id));

  // Check for desync
  const missingRevisions: string[] = [];
  const extraRevisions: string[] = [];

  const allEntries = readVersionLog(); // Check against all entries, not filtered
  allEntries.forEach((entry) => {
    if (!driveRevisionIds.has(entry.revisionId)) {
      extraRevisions.push(entry.revisionId);
    }
  });

  driveRevisions.forEach((rev) => {
    const found = allEntries.find((e) => e.revisionId === rev.id);
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
      Company: entry.company || '-',
      'Job Title': entry.jobTitle || '-',
      'Change Count': entry.changes.length,
      Type: entry.isRevert ? 'Revert' : 'Update',
      'In Drive': driveRev ? '✓' : '✗',
    };
  });

  if (companyFilter || jobFilter) {
    console.log(`\nFiltered Version History (${localEntries.length} of ${allEntries.length} entries):`);
    if (companyFilter) console.log(`  Company filter: "${companyFilter}"`);
    if (jobFilter) console.log(`  Job filter: "${jobFilter}"`);
  } else {
    console.log('\nVersion History:');
  }
  console.table(tableData);
}

/**
 * Search versions by company or job title
 */
async function handleSearch(): Promise<void> {
  const args = process.argv.slice(2);
  // Skip 'search' command itself, find the search term
  const searchTerm = args.slice(1).find((arg) => !arg.startsWith('--'));
  
  if (!searchTerm) {
    console.error('Usage: npm start search "search term"');
    process.exit(1);
  }
  
  const localEntries = readVersionLog();
  const termLower = searchTerm.toLowerCase();
  
  const matches = localEntries.filter((entry) => {
    const companyMatch = entry.company?.toLowerCase().includes(termLower);
    const jobMatch = entry.jobTitle?.toLowerCase().includes(termLower);
    return companyMatch || jobMatch;
  });
  
  if (matches.length === 0) {
    console.log(`No versions found matching "${searchTerm}"`);
    return;
  }
  
  console.log(`Found ${matches.length} version(s) matching "${searchTerm}":\n`);
  
  const tableData = matches.map((entry) => {
    const originalIndex = localEntries.indexOf(entry);
    return {
      Index: originalIndex,
      'Revision ID': entry.revisionId.substring(0, 8) + '...',
      Timestamp: new Date(entry.timestamp).toLocaleString(),
      Company: entry.company || '-',
      'Job Title': entry.jobTitle || '-',
      'Change Count': entry.changes.length,
    };
  });
  
  console.table(tableData);
}

/**
 * Tag existing version with metadata
 */
async function handleTag(): Promise<void> {
  const args = process.argv.slice(2);
  const tagArg = args.find((arg) => !arg.startsWith('--'));
  
  if (!tagArg) {
    console.error('Usage: npm start tag <index|revisionId> --company "X" --job-title "Y" [--url "Z"]');
    process.exit(1);
  }
  
  const companyIndex = args.indexOf('--company');
  const jobTitleIndex = args.indexOf('--job-title');
  const urlIndex = args.indexOf('--url');
  
  const company = companyIndex !== -1 && args[companyIndex + 1] ? args[companyIndex + 1] : undefined;
  const jobTitle = jobTitleIndex !== -1 && args[jobTitleIndex + 1] ? args[jobTitleIndex + 1] : undefined;
  const jobUrl = urlIndex !== -1 && args[urlIndex + 1] ? args[urlIndex + 1] : undefined;
  
  if (!company && !jobTitle && !jobUrl) {
    console.error('At least one of --company, --job-title, or --url is required');
    process.exit(1);
  }
  
  const localEntries = readVersionLog();
  let targetEntry: VersionLogEntry | undefined;
  let targetIndex = -1;
  
  // Try as index first
  const index = parseInt(tagArg, 10);
  if (!isNaN(index) && index >= 0 && index < localEntries.length) {
    targetEntry = localEntries[index];
    targetIndex = index;
  } else {
    // Try as revision ID
    const foundIndex = localEntries.findIndex((e) => e.revisionId === tagArg);
    if (foundIndex !== -1) {
      targetEntry = localEntries[foundIndex];
      targetIndex = foundIndex;
    }
  }
  
  if (!targetEntry) {
    console.error('Version not found. Use "list" to see available versions.');
    process.exit(1);
  }
  
  // Update metadata
  if (company) targetEntry.company = company;
  if (jobTitle) targetEntry.jobTitle = jobTitle;
  if (jobUrl) targetEntry.jobUrl = jobUrl;
  
  // Write back to log
  localEntries[targetIndex] = targetEntry;
  writeVersionLog(localEntries);
  
  console.log(`Tagged revision ${targetEntry.revisionId}:`);
  if (company) console.log(`  Company: ${company}`);
  if (jobTitle) console.log(`  Job Title: ${jobTitle}`);
  if (jobUrl) console.log(`  URL: ${jobUrl}`);
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
 * Export specific resume version as PDF or DOCX
 */
async function handleExport(): Promise<void> {
  const args = process.argv.slice(2);
  const exportArg = args.find((arg) => !arg.startsWith('--'));
  
  if (!exportArg) {
    console.error('Usage: npm start export <index|revisionId> [--format pdf|docx]');
    process.exit(1);
  }
  
  // Parse format flag
  const formatIndex = args.indexOf('--format');
  const format = (formatIndex !== -1 && args[formatIndex + 1] === 'docx') ? 'docx' : 'pdf';
  
  const localEntries = readVersionLog();
  let targetEntry: VersionLogEntry | undefined;
  
  // Try as index first
  const index = parseInt(exportArg, 10);
  if (!isNaN(index) && index >= 0 && index < localEntries.length) {
    targetEntry = localEntries[index];
  } else {
    // Try as revision ID
    targetEntry = localEntries.find((e) => e.revisionId === exportArg);
  }
  
  if (!targetEntry) {
    console.error('Version not found. Use "list" to see available versions.');
    process.exit(1);
  }
  
  console.log(`Exporting revision: ${targetEntry.revisionId}`);
  console.log(`Format: ${format.toUpperCase()}`);
  
  // Create exports directory if it doesn't exist
  const fs = await import('fs');
  const path = await import('path');
  const exportsDir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  
  // Generate filename
  const timestamp = new Date(targetEntry.timestamp).toISOString().split('T')[0];
  const company = targetEntry.company?.replace(/[^a-zA-Z0-9]/g, '-') || 'unknown';
  const jobTitle = targetEntry.jobTitle?.replace(/[^a-zA-Z0-9]/g, '-') || 'untitled';
  const filename = `resume-${company}-${jobTitle}-${timestamp}.${format}`;
  const outputPath = path.join(exportsDir, filename);
  
  try {
    // Note: Google Drive API doesn't support exporting specific revisions directly.
    // This exports the current version. To export a specific revision, we would
    // need to temporarily restore that revision first, which is more complex.
    // For MVP, we export current version and note the limitation.
    console.log('Note: Exporting current version (revision-specific export requires restore first)');
    await exportRevision(config.RESUME_FILE_ID, format, outputPath);
    console.log(`✓ Exported to: ${outputPath}`);
  } catch (error) {
    console.error('Export failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Monitor companies and discover jobs
 */
async function handleMonitor(): Promise<void> {
  const args = process.argv.slice(2);
  const processQueue = args.includes('--process');
  
  if (processQueue) {
    // Process job queue
    const queue = readJobQueue();
    if (queue.length === 0) {
      console.log('Job queue is empty. Run monitor first to discover jobs.');
      return;
    }
    
    console.log(`Processing ${queue.length} job(s) from queue...\n`);
    const urls = queue.map((j) => j.url);
    
    // Use batch processing logic
    const dryRun = isDryRun();
    const results: Array<{ url: string; success: boolean }> = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const job = queue[i];
      console.log(`\n[${i + 1}/${urls.length}] Processing: ${job.company} - ${job.jobTitle}`);
      console.log(`URL: ${url}`);
      console.log('-'.repeat(60));
      
      try {
        const jobDescription = await fetchJobDescriptionFromUrl(url);
        const metadata = {
          company: job.company,
          jobTitle: job.jobTitle,
          jobUrl: url,
        };
        
        const result = await performUpdate(jobDescription, url, metadata, dryRun);
        results.push({ url, success: result.success || false });
        
        if (result.success) {
          console.log(`✓ Successfully processed`);
        }
      } catch (error) {
        console.error(`✗ Error: ${error instanceof Error ? error.message : String(error)}`);
        results.push({ url, success: false });
      }
    }
    
    // Remove processed jobs from queue
    const remaining = queue.filter((_, i) => !results[i]?.success);
    writeJobQueue(remaining);
    console.log(`\nQueue updated: ${remaining.length} job(s) remaining`);
  } else {
    // Discover jobs
    await monitorCompanies();
  }
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
      case 'batch':
        await handleBatch();
        break;
      case 'list':
        await handleList();
        break;
      case 'revert':
        await handleRevert();
        break;
      case 'export':
        await handleExport();
        break;
      case 'monitor':
        await handleMonitor();
        break;
      case 'search':
        await handleSearch();
        break;
      case 'tag':
        await handleTag();
        break;
      case 'source':
        await sourceJobOpportunities();
        break;
      default:
        console.log('Usage:');
        console.log('  npm start -- update --jd "job description text" [--dry-run] [--company "X"] [--job-title "Y"]');
        console.log('  npm start -- update --jd-file path/to/jd.txt [--dry-run] [--company "X"] [--job-title "Y"]');
        console.log('  npm start -- update --jd-url "https://jobs.company.com/position" [--dry-run] [--company "X"] [--job-title "Y"]');
        console.log('  npm start -- batch --urls "url1 url2 url3" [--dry-run]');
        console.log('  npm start -- batch --file path/to/urls.txt [--dry-run]');
        console.log('  npm start list [--company "X"] [--job "Y"]');
        console.log('  npm start revert <index|revisionId>');
        console.log('  npm start export <index|revisionId> [--format pdf|docx]');
        console.log('  npm start monitor [--process]');
        console.log('  npm start search "search term"');
        console.log('  npm start tag <index|revisionId> --company "X" --job-title "Y" [--url "Z"]');
        console.log('  npm start source');
        console.log('');
        console.log('Note: Use -- after npm start to pass arguments correctly');
        console.log('Metadata (company/job-title) is auto-extracted from URLs when using --jd-url');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

