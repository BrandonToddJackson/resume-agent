import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';
import { writeFileSync, readFileSync, existsSync, statSync } from 'fs';

/**
 * Job opportunity schema
 */
const JobOpportunitySchema = z.object({
  company: z.string(),
  jobTitle: z.string(),
  jobUrl: z.string().url(),
  companyUrl: z.string().url().optional(),
  fundingStatus: z.string().optional(),
  ycBatch: z.string().optional(),
  fitScore: z.number().min(0).max(100),
  remoteStatus: z.string(),
  contractFriendly: z.boolean().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

const JobSourceResponseSchema = z.object({
  longList: z.array(JobOpportunitySchema),
  shortList: z.array(JobOpportunitySchema),
  summary: z.object({
    totalFound: z.number(),
    ycCompanies: z.number(),
    seriesAB: z.number(),
    topFitScore: z.number(),
  }),
  outreachSuggestions: z.array(z.string()).optional(),
  metadata: z.object({
    generatedAt: z.string(),
    modelVersion: z.string(),
    searchSettings: z.record(z.any()).optional(),
  }).optional(),
});

type JobSourceResponse = z.infer<typeof JobSourceResponseSchema>;

/**
 * Check if a job URL is still active (accessible and not closed)
 */
async function validateJobActive(jobUrl: string): Promise<boolean> {
  try {
    // Quick HEAD request to check if URL is accessible
    const response = await axios.head(jobUrl, {
      timeout: 5000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500, // Don't throw on 404, just return false
    });

    // If URL returns 404 or 410, job is likely closed
    if (response.status === 404 || response.status === 410) {
      return false;
    }

    // For aggregator sites or redirects, do a quick GET to check content
    if (response.status >= 200 && response.status < 300) {
      // Quick content check for "filled", "closed", "no longer accepting"
      try {
        const getResponse = await axios.get(jobUrl, {
          timeout: 5000,
          maxRedirects: 5,
          validateStatus: () => true,
        });
        
        const content = getResponse.data?.toString().toLowerCase() || '';
        const closedIndicators = [
          'position filled',
          'job closed',
          'no longer accepting',
          'position has been filled',
          'this position is closed',
          'application closed',
        ];
        
        // If page contains closed indicators, job is inactive
        if (closedIndicators.some(indicator => content.includes(indicator))) {
          return false;
        }
      } catch {
        // If GET fails but HEAD succeeded, assume active
        return true;
      }
      
      return true;
    }

    return false;
  } catch (error) {
    // If we can't verify, assume inactive to be safe
    console.warn(`Could not verify job URL ${jobUrl}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Validate all jobs are still active
 */
async function validateJobsActive(jobs: Array<{ jobUrl: string }>): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  
  // Validate in parallel for speed (limit to 10 concurrent)
  const batchSize = 10;
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    const promises = batch.map(async (job) => {
      const isActive = await validateJobActive(job.jobUrl);
      return [job.jobUrl, isActive] as [string, boolean];
    });
    
    const batchResults = await Promise.all(promises);
    batchResults.forEach(([url, active]) => results.set(url, active));
  }
  
  return results;
}

/**
 * Validate data quality and consistency
 */
function validateDataQuality(data: JobSourceResponse): void {
  // Check summary matches actual data
  const actualTotal = data.longList.length;
  if (data.summary.totalFound !== actualTotal) {
    console.warn(`Warning: Summary totalFound (${data.summary.totalFound}) doesn't match longList length (${actualTotal})`);
  }

  // Check shortList is subset of longList
  const shortListUrls = new Set(data.shortList.map(j => j.jobUrl));
  const longListUrls = new Set(data.longList.map(j => j.jobUrl));
  for (const url of shortListUrls) {
    if (!longListUrls.has(url)) {
      console.warn(`Warning: shortList contains URL not in longList: ${url}`);
    }
  }

  // Check for duplicate URLs
  const seenUrls = new Set<string>();
  const duplicates: string[] = [];
  for (const job of data.longList) {
    if (seenUrls.has(job.jobUrl)) {
      duplicates.push(job.jobUrl);
    }
    seenUrls.add(job.jobUrl);
  }
  if (duplicates.length > 0) {
    console.warn(`Warning: Found ${duplicates.length} duplicate job URLs`);
  }

  // Validate fit scores
  for (const job of data.longList) {
    if (job.fitScore < 0 || job.fitScore > 100) {
      throw new Error(`Invalid fit score: ${job.fitScore} (must be 0-100)`);
    }
  }
}

/**
 * Remove duplicates and validate URLs
 */
function cleanData(data: JobSourceResponse): JobSourceResponse {
  // Remove duplicates by URL
  const seen = new Map<string, typeof data.longList[0]>();
  for (const job of data.longList) {
    if (!seen.has(job.jobUrl)) {
      seen.set(job.jobUrl, job);
    }
  }
  const cleanedLongList = Array.from(seen.values());

  // Rebuild shortList from cleaned longList (top 10 for speed, prefer active jobs)
  const cleanedShortList = cleanedLongList
    .sort((a, b) => {
      // Sort by: active first, then by fit score
      if (a.isActive !== b.isActive) {
        return (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0);
      }
      return b.fitScore - a.fitScore;
    })
    .slice(0, Math.min(10, cleanedLongList.length));

  // Update summary
  const ycCount = cleanedLongList.filter(j => j.fundingStatus?.includes('YC')).length;
  const seriesABCount = cleanedLongList.filter(j => 
    j.fundingStatus?.includes('Series A') || j.fundingStatus?.includes('Series B')
  ).length;
  const topFit = cleanedShortList.length > 0 ? cleanedShortList[0].fitScore : 0;

  return {
    ...data,
    longList: cleanedLongList,
    shortList: cleanedShortList,
    summary: {
      totalFound: cleanedLongList.length,
      ycCompanies: ycCount,
      seriesAB: seriesABCount,
      topFitScore: topFit,
    },
  };
}

/**
 * Build prompt that explicitly uses web search for real results (optimized for speed)
 */
function buildHeadhunterPrompt(): string {
  return `Search web for remote AI/data science jobs at YC companies and Series A/B startups. Extract REAL job postings only.

Search queries (use web search):
1. "Y Combinator companies remote data scientist jobs"
2. "Series A startup remote AI engineer jobs 2025"

For each job posting found:
- Extract: company name, job title, job URL, company URL
- Mark funding: "YC SXX" if YC company, "Series A" or "Series B" if funded startup
- Check remote status: "100% remote", "hybrid", or "on-site"

Candidate: 10+ yrs data/AI, Python/TypeScript, 100% remote only, US-based.

Score 0-100: role match, 100% remote, contract-friendly.

Return JSON (REAL jobs only, accessible URLs):
{"longList": [{"company": "...", "jobTitle": "...", "jobUrl": "https://...", "companyUrl": "https://...", "fundingStatus": "YC S23"|"Series A"|"Series B"|null, "ycBatch": "S23"|null, "fitScore": 0-100, "remoteStatus": "100% remote"|"hybrid", "contractFriendly": true|false}], "shortList": [...top 10...], "summary": {"totalFound": X, "ycCompanies": Y, "seriesAB": Z, "topFitScore": W}}

Find 5-10 real postings. If none found, return empty lists.`;
}

/**
 * Check if cached results are still valid (<24 hours old)
 */
function isCacheValid(cachePath: string): boolean {
  if (!existsSync(cachePath)) return false;
  
  try {
    const stats = statSync(cachePath);
    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    return ageHours < 24; // Cache valid for 24 hours
  } catch {
    return false;
  }
}

/**
 * Load cached results if available and valid
 */
function loadCachedResults(cachePath: string): JobSourceResponse | null {
  if (!isCacheValid(cachePath)) return null;
  
  try {
    const content = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(content);
    return JobSourceResponseSchema.parse(parsed);
  } catch {
    return null;
  }
}

/**
 * Use Groq Compound model with web search (cost-optimized: basic search, domain limits)
 */
async function sourceWithGroqWebSearch(): Promise<JobSourceResponse> {
  const prompt = buildHeadhunterPrompt();
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'groq/compound',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          response_format: { type: 'json_object' },
          // Search settings: broader scope for real results (don't restrict too much)
          search_settings: {
            // Don't restrict domains too much - let Groq search broadly
            // Only exclude spam/irrelevant sites
            exclude_domains: ['facebook.com', 'twitter.com', 'instagram.com'],
            country: 'united states',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${config.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
            // Use latest version for better search results (advanced search)
            // 'Groq-Model-Version': '2025-07-23', // Commented out to use advanced search
          },
          timeout: 120000, // 2 minute timeout for web searches
        }
      );

      const message = response.data.choices[0]?.message;
      let content = message?.content;
      
      // If content is empty, check if reasoning has the answer
      if (!content || content.trim() === '') {
        const reasoning = message?.reasoning;
        if (reasoning && typeof reasoning === 'string') {
          // Try to extract JSON from reasoning
          const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            content = jsonMatch[0];
          } else {
            console.error('Groq API response - empty content and no JSON in reasoning');
            console.error('Response structure:', JSON.stringify(response.data, null, 2).substring(0, 2000));
            throw new Error('Invalid response format from Groq API - no content in response');
          }
        } else {
          console.error('Groq API response - empty content and no reasoning');
          console.error('Response structure:', JSON.stringify(response.data, null, 2).substring(0, 2000));
          throw new Error('Invalid response format from Groq API - no content in response');
        }
      }
      
      if (typeof content !== 'string') {
        throw new Error('Invalid response format from Groq API - content is not a string');
      }
      
      // Log raw response for debugging (first 500 chars)
      if (attempt === 1) {
        console.log('Raw Groq response preview:', content.substring(0, 500));
      }
      
      // Check if Groq actually used web search
      const executedTools = response.data.choices[0]?.message?.executed_tools;
      if (executedTools && executedTools.length > 0) {
        console.log(`Groq performed ${executedTools.length} web search(es)`);
      } else {
        console.warn('Warning: Groq may not have performed web search');
      }

      // Extract JSON from response (robust parsing for speed)
      let jsonText = content.trim();
      
      // Fast path: if it's already JSON, use it
      if (jsonText.startsWith('{') && jsonText.endsWith('}')) {
        try {
          const parsed = JSON.parse(jsonText);
          if (parsed.longList || parsed.shortList) {
            return JobSourceResponseSchema.parse(parsed);
          }
        } catch {
          // Fall through to extraction
        }
      }
      
      // Extract JSON from markdown or mixed content
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      } else {
        // Try code blocks
        const codeBlockMatch = jsonText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch && codeBlockMatch[1]) {
          jsonText = codeBlockMatch[1];
        }
      }

      let parsed = JSON.parse(jsonText);
      
      // Normalize null values to undefined for optional fields (Zod doesn't accept null)
      const normalizeJob = (job: any) => ({
        ...job,
        ycBatch: job.ycBatch || undefined,
        companyUrl: job.companyUrl || undefined,
        fundingStatus: job.fundingStatus || undefined,
        contractFriendly: job.contractFriendly ?? undefined,
        description: job.description || undefined,
        isActive: job.isActive ?? undefined, // Will be set during validation
      });
      
      if (parsed.longList) {
        parsed.longList = parsed.longList
          .map(normalizeJob)
          .filter((job: any) => job.jobUrl && typeof job.jobUrl === 'string'); // Filter out invalid URLs
      }
      if (parsed.shortList) {
        parsed.shortList = parsed.shortList
          .map(normalizeJob)
          .filter((job: any) => job.jobUrl && typeof job.jobUrl === 'string'); // Filter out invalid URLs
      }
      
      const validated = JobSourceResponseSchema.parse(parsed);
      
      // Add metadata
      validated.metadata = {
        generatedAt: new Date().toISOString(),
        modelVersion: '2025-07-23',
        searchSettings: {
          include_domains: ['ycombinator.com', 'linkedin.com', 'greenhouse.io', 'lever.co'],
        },
      };
      
      // Clean and validate data quality
      const cleaned = cleanData(validated);
      validateDataQuality(cleaned);
      
      // Validate URLs are real (basic check)
      for (const job of cleaned.longList) {
        if (!job.jobUrl.startsWith('http://') && !job.jobUrl.startsWith('https://')) {
          console.warn(`Warning: Invalid URL format: ${job.jobUrl}`);
        }
        if (job.jobUrl.includes('example.com') || job.jobUrl.includes('placeholder')) {
          console.warn(`Warning: Suspicious placeholder URL: ${job.jobUrl}`);
        }
      }
      
      return cleaned;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;
        const data = error.response.data;
        throw new Error(`Groq API Error ${status}: ${data?.error?.message || error.message}`);
      }

      const isRetryable = attempt < maxRetries &&
        (lastError.message.includes('JSON') || lastError.message.includes('parse'));

      if (!isRetryable) {
        throw lastError;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw lastError || new Error('Failed to source job opportunities');
}

/**
 * Format human-readable output
 */
function formatHumanOutput(data: JobSourceResponse): string {
  let output = '\n============================================================\n';
  output += 'JOB SOURCING RESULTS\n';
  output += '============================================================\n\n';

  output += `SUMMARY:\n`;
  output += `  Total Opportunities Found: ${data.summary.totalFound}\n`;
  output += `  Y Combinator Companies: ${data.summary.ycCompanies}\n`;
  output += `  Series A/B Funded: ${data.summary.seriesAB}\n`;
  output += `  Top Fit Score: ${data.summary.topFitScore}/100\n\n`;

  output += `TOP ${data.shortList.length} OPPORTUNITIES (Ranked by Fit):\n`;
  output += '------------------------------------------------------------\n';

  data.shortList.forEach((job, index) => {
    output += `\n${index + 1}. ${job.jobTitle} @ ${job.company}\n`;
    output += `   Fit Score: ${job.fitScore}/100\n`;
    output += `   URL: ${job.jobUrl}\n`;
    if (job.companyUrl) output += `   Company: ${job.companyUrl}\n`;
    if (job.fundingStatus) output += `   Funding: ${job.fundingStatus}\n`;
    if (job.ycBatch) output += `   YC Batch: ${job.ycBatch}\n`;
    output += `   Remote: ${job.remoteStatus}\n`;
    if (job.isActive !== undefined) {
      output += `   Status: ${job.isActive ? '✓ Active' : '✗ Inactive/Closed'}\n`;
    }
    if (job.contractFriendly !== undefined) {
      output += `   Contract-Friendly: ${job.contractFriendly ? 'Yes' : 'No'}\n`;
    }
    if (job.description) {
      output += `   Description: ${job.description.substring(0, 150)}...\n`;
    }
  });

  output += '\n============================================================\n';
  return output;
}

/**
 * Main job sourcing function using Groq's native web search (cost-optimized)
 */
export async function sourceJobOpportunities(): Promise<void> {
  const cachePath = 'job_opportunities.json';
  
  // Check cache first (cost optimization)
  const cached = loadCachedResults(cachePath);
  if (cached) {
    console.log('Using cached results (less than 24 hours old)\n');
    const humanOutput = formatHumanOutput(cached);
    console.log(humanOutput);
    console.log(`\nTo refresh results, delete ${cachePath} and run again.`);
    return;
  }

  console.log('Starting job sourcing with Groq web search (lightning-fast mode)...\n');
  console.log('Speed optimizations:');
  console.log('  - Ultra-short prompt (minimal processing)');
  console.log('  - Basic search tier (faster)');
  console.log('  - Domain-focused searches');
  console.log('  - Top 10 results only (minimal processing)\n');
  console.log('Search plan:');
  console.log('  1. Search for Y Combinator companies with remote AI/data roles');
  console.log('  2. Search for Series A/B funded startups (last 30 days)');
  console.log('  3. Extract job postings from career pages');
  console.log('  4. Analyze and rank by fit score\n');

  try {
    console.log('Using Groq Compound model with basic web search...');
    const analysis = await sourceWithGroqWebSearch();

    // Validate jobs are still active
    console.log('\nValidating job URLs are still active...');
    const activeStatus = await validateJobsActive(analysis.longList);
    
    // Add isActive status to jobs
    analysis.longList = analysis.longList.map(job => ({
      ...job,
      isActive: activeStatus.get(job.jobUrl) ?? false,
    }));
    
    // Filter shortList to only active jobs
    analysis.shortList = analysis.shortList
      .map(job => ({
        ...job,
        isActive: activeStatus.get(job.jobUrl) ?? false,
      }))
      .filter(job => job.isActive)
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 10);
    
    const activeCount = Array.from(activeStatus.values()).filter(Boolean).length;
    console.log(`✓ Validated ${analysis.longList.length} jobs: ${activeCount} active, ${analysis.longList.length - activeCount} inactive`);

    // Format and display
    const humanOutput = formatHumanOutput(analysis);
    console.log(humanOutput);

    // Save JSON (cached for 24 hours)
    writeFileSync(cachePath, JSON.stringify(analysis, null, 2));
    console.log(`\nFull results saved to: ${cachePath} (cached for 24 hours)`);
    
    if (analysis.metadata) {
      console.log(`Generated at: ${analysis.metadata.generatedAt}`);
    }

    if (analysis.outreachSuggestions && analysis.outreachSuggestions.length > 0) {
      console.log('\nOUTREACH SUGGESTIONS:');
      analysis.outreachSuggestions.forEach((suggestion, i) => {
        console.log(`${i + 1}. ${suggestion}`);
      });
    }
  } catch (error) {
    console.error('Job sourcing error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
