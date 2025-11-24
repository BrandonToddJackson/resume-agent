import { readFileSync, writeFileSync, existsSync } from 'fs';
import Firecrawl from '@mendable/firecrawl-js';
import { config } from './config.js';
import { z } from 'zod';

/**
 * Company configuration schema
 */
const CompanySchema = z.object({
  name: z.string(),
  careerPageUrl: z.string().url(),
  filters: z.object({
    roles: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
  }).optional(),
});

const CompaniesConfigSchema = z.array(CompanySchema);

type CompanyConfig = z.infer<typeof CompanySchema>;

/**
 * Job queue entry schema
 */
const JobQueueEntrySchema = z.object({
  company: z.string(),
  url: z.string().url(),
  jobTitle: z.string(),
  discoveredAt: z.string(),
});

const JobQueueSchema = z.array(JobQueueEntrySchema);

type JobQueueEntry = z.infer<typeof JobQueueEntrySchema>;

const COMPANIES_FILE = 'companies.json';
const JOB_QUEUE_FILE = 'jobs_queue.json';

/**
 * Read companies configuration
 */
export function readCompaniesConfig(): CompanyConfig[] {
  if (!existsSync(COMPANIES_FILE)) {
    return [];
  }

  try {
    const content = readFileSync(COMPANIES_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    return CompaniesConfigSchema.parse(parsed);
  } catch (error) {
    console.error('Error reading companies config:', error);
    return [];
  }
}

/**
 * Read job queue
 */
export function readJobQueue(): JobQueueEntry[] {
  if (!existsSync(JOB_QUEUE_FILE)) {
    return [];
  }

  try {
    const content = readFileSync(JOB_QUEUE_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    return JobQueueSchema.parse(parsed);
  } catch (error) {
    console.error('Error reading job queue:', error);
    return [];
  }
}

/**
 * Write job queue
 */
export function writeJobQueue(queue: JobQueueEntry[]): void {
  writeFileSync(JOB_QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n');
}

/**
 * Extract job postings from career page markdown
 */
export function extractJobPostings(markdown: string, company: string): JobQueueEntry[] {
  const jobs: JobQueueEntry[] = [];
  const lines = markdown.split('\n');
  
  // Look for job title patterns (headers, links, etc.)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Match markdown links: [Job Title](url)
    const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const jobTitle = linkMatch[1];
      const url = linkMatch[2];
      
      // Check if URL looks like a job posting
      if (url.includes('/careers/') || url.includes('/jobs/') || url.includes('/openings/')) {
        let fullUrl = url;
        if (!url.startsWith('http')) {
          try {
            const urlObj = new URL(url, 'https://example.com');
            fullUrl = urlObj.href;
          } catch {
            // Skip invalid URLs
            continue;
          }
        }
        jobs.push({
          company,
          url: fullUrl,
          jobTitle,
          discoveredAt: new Date().toISOString(),
        });
      }
    }
    
    // Match headers with job titles
    if (line.startsWith('#') && line.length > 3) {
      const title = line.replace(/^#+\s*/, '').trim();
      if (title.length > 5 && title.length < 100) {
        // Look for URL in next few lines
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nextLine = lines[j];
          const urlMatch = nextLine.match(/https?:\/\/[^\s)]+/);
          if (urlMatch && (urlMatch[0].includes('/careers/') || urlMatch[0].includes('/jobs/'))) {
            jobs.push({
              company,
              url: urlMatch[0],
              jobTitle: title,
              discoveredAt: new Date().toISOString(),
            });
            break;
          }
        }
      }
    }
  }
  
  return jobs;
}

/**
 * Filter jobs by company criteria
 */
function filterJobs(jobs: JobQueueEntry[], company: CompanyConfig): JobQueueEntry[] {
  const filters = company.filters;
  if (!filters) {
    return jobs;
  }
  
  return jobs.filter((job) => {
    // Filter by roles
    const roles = filters.roles;
    if (roles && roles.length > 0) {
      const jobLower = job.jobTitle.toLowerCase();
      const matchesRole = roles.some((role) =>
        jobLower.includes(role.toLowerCase())
      );
      if (!matchesRole) {
        return false;
      }
    }
    
    // Note: Location filtering would require parsing JD content
    // For MVP, we skip location filtering from markdown
    
    return true;
  });
}

/**
 * Discover jobs from company career page
 */
export async function discoverJobs(company: CompanyConfig): Promise<JobQueueEntry[]> {
  if (!config.FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY required for job discovery');
  }

  console.log(`Discovering jobs from ${company.name}...`);
  
  try {
    const firecrawl = new Firecrawl({ apiKey: config.FIRECRAWL_API_KEY });
    const response = await firecrawl.scrapeUrl(company.careerPageUrl, {
      formats: ['markdown'],
    });

    if (!('success' in response) || !response.success || !response.markdown) {
      throw new Error('Failed to scrape career page');
    }

    let markdown = response.markdown.trim();
    markdown = markdown.replace(/!\[.*?\]\([^)]+\)/g, '');
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    const allJobs = extractJobPostings(markdown, company.name);
    const filteredJobs = filterJobs(allJobs, company);

    console.log(`  Found ${filteredJobs.length} job(s) matching criteria`);
    return filteredJobs;
  } catch (error) {
    console.error(`Error discovering jobs from ${company.name}:`, error);
    return [];
  }
}

/**
 * Monitor all companies and build job queue
 */
export async function monitorCompanies(): Promise<JobQueueEntry[]> {
  const companies = readCompaniesConfig();
  
  if (companies.length === 0) {
    console.error('No companies configured. Create companies.json file.');
    return [];
  }

  console.log(`Monitoring ${companies.length} company/companies...\n`);
  
  const allJobs: JobQueueEntry[] = [];
  
  for (const company of companies) {
    const jobs = await discoverJobs(company);
    allJobs.push(...jobs);
    
    // Small delay between companies
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  
  // Merge with existing queue (avoid duplicates)
  const existingQueue = readJobQueue();
  const existingUrls = new Set(existingQueue.map((j) => j.url));
  const newJobs = allJobs.filter((j) => !existingUrls.has(j.url));
  
  if (newJobs.length > 0) {
    const updatedQueue = [...existingQueue, ...newJobs];
    writeJobQueue(updatedQueue);
    console.log(`\nAdded ${newJobs.length} new job(s) to queue`);
  } else {
    console.log('\nNo new jobs found');
  }
  
  return allJobs;
}

