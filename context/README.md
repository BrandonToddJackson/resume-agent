# Resume Agent MVP

CLI tool that uses AI to semantically align your Google Doc resume with job descriptions. Instead of superficial word replacements, it intelligently maps JD requirements to your experience and rephrases bullet points to highlight relevant skills.

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure .env (see Setup section)

# 3. Update resume with a job URL
npm start -- update --jd-url "https://jobs.company.com/ai-engineer"
```

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment Variables

Create `.env` file:

```bash
cp .env.example .env
```

Required variables:
- `GROQ_API_KEY`: Your Groq API key ([get one here](https://console.groq.com))
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to Google service account JSON key
- `RESUME_FILE_ID`: Your Google Doc file ID (from URL: `https://docs.google.com/document/d/FILE_ID/edit`)
- `FIRECRAWL_API_KEY`: Your Firecrawl API key (required for `--jd-url` and batch processing) ([get one here](https://firecrawl.dev))

### 3. Google Drive Setup

1. Create a Google Cloud project and enable Google Drive API
2. Create a service account and download the JSON key
3. Share your Google Doc resume with the service account email (found in the JSON key file) as **Editor**

### 4. (Optional) Company Monitoring Setup

Create `companies.json` to monitor company career pages:

```bash
cp companies.json.example companies.json
```

Edit `companies.json`:

```json
[
  {
    "name": "Plaid",
    "careerPageUrl": "https://plaid.com/careers",
    "filters": {
      "roles": ["engineer", "ml", "data"],
      "locations": ["san francisco", "remote"]
    }
  }
]
```

## Usage Guide

### Single Resume Update

Update your resume to align with a job description using one of three methods:

#### Method 1: Direct Text Input

```bash
npm start -- update --jd "Software engineer with TypeScript experience, building scalable systems"
```

#### Method 2: From File

```bash
npm start -- update --jd-file path/to/job-description.txt
```

#### Method 3: From URL (Recommended)

```bash
npm start -- update --jd-url "https://jobs.company.com/ai-engineer"
```

**Note**: The `--` after `npm start` is required to pass arguments correctly. Without it, npm may strip quotes from multi-word job descriptions.

#### Optional Flags

- `--dry-run`: Preview changes without applying them
- `--company "Company Name"`: Override auto-extracted company name
- `--job-title "Job Title"`: Override auto-extracted job title

**Example with flags**:

```bash
npm start -- update --jd-url "https://jobs.company.com/ai-engineer" --dry-run --company "TechCorp" --job-title "Senior AI Engineer"
```

### Batch Processing

Process multiple job URLs at once to create multiple resume versions:

#### From Command Line

```bash
npm start -- batch --urls "https://jobs.company1.com/role1 https://jobs.company2.com/role2 https://jobs.company3.com/role3"
```

#### From File

Create `urls.txt`:

```
https://jobs.company1.com/role1
https://jobs.company2.com/role2
https://jobs.company3.com/role3
```

Then run:

```bash
npm start -- batch --file urls.txt
```

**Options**:
- `--dry-run`: Preview all changes without applying

**What happens**:
1. Each URL is processed sequentially
2. Job description is extracted from each URL
3. Company and job title are auto-extracted (from URL or JD content)
4. Resume is updated and a new version is created
5. Version is tagged with company/job metadata
6. Processing continues even if one URL fails

### Version Management

#### List All Versions

```bash
npm start list
```

**Filter by company or job**:

```bash
npm start list --company "Plaid"
npm start list --job "ML Engineer"
```

**Output shows**:
- Index (for revert/export)
- Revision ID
- Timestamp
- Company
- Job Title
- Job URL
- Number of changes

#### Revert to Previous Version

```bash
# By index (from list output)
npm start revert 0

# By revision ID
npm start revert 1a2b3c4d5e6f7g8h
```

#### Export Resume Version

Download a specific version as PDF or DOCX:

```bash
# Export as PDF (default)
npm start export 0

# Export as DOCX
npm start export 0 --format docx

# Export by revision ID
npm start export 1a2b3c4d5e6f7g8h --format pdf
```

Exported files are saved to `exports/` directory with filename:
```
resume-{company}-{jobTitle}-{timestamp}.{ext}
```

### Company Monitoring

Automatically discover and process jobs from company career pages:

#### Discover Jobs (One-Time Scan)

```bash
npm start monitor
```

This will:
1. Read `companies.json` configuration
2. Scrape each company's career page
3. Extract job postings matching your filters (roles, locations)
4. Add discovered jobs to `jobs_queue.json`
5. Display discovered jobs (not processed yet)

#### Process Discovered Jobs

```bash
npm start monitor --process
```

This will:
1. Read `jobs_queue.json`
2. Process each job URL (extract JD, update resume, create version)
3. Tag each version with company/job metadata
4. Clear processed jobs from queue

**Workflow**:

```bash
# Step 1: Discover new jobs
npm start monitor

# Step 2: Review jobs_queue.json (optional)

# Step 3: Process all discovered jobs
npm start monitor --process
```

### Search and Tagging

#### Search Version Logs

Search for versions by company name, job title, or keywords:

```bash
npm start search "machine learning"
npm start search "Plaid"
npm start search "engineer"
```

#### Tag Existing Versions

Add or update metadata for an existing version:

```bash
npm start tag 0 --company "TechCorp" --job-title "Senior Engineer" --url "https://jobs.techcorp.com/123"
```

Useful when:
- Metadata wasn't auto-extracted correctly
- You want to add metadata to old versions
- You need to correct company/job information

### Job Sourcing

Automatically discover job opportunities from Y Combinator companies and Series A/B funded startups:

```bash
npm start source
```

**What it does**:
1. Searches for Y Combinator companies with remote AI/data/product roles
2. Searches for Series A/B funded startups (last 30 days) with remote roles
3. Uses AI headhunter analysis to rank opportunities by fit score
4. Outputs ranked list with company info, job URLs, and fit scores
5. Saves full results to `job_opportunities.json`

**Output includes**:
- **Long list**: All opportunities found
- **Short list**: Top 10 ranked by fit score (0-100)
- **Summary**: Total found, YC companies count, Series A/B count
- **Fit scoring**: Based on role alignment, remote status, contract-friendliness
- **Company metadata**: Funding status, YC batch (if applicable)

**Example output**:
```
JOB SOURCING RESULTS
============================================================

SUMMARY:
  Total Opportunities Found: 25
  Y Combinator Companies: 8
  Series A/B Funded: 12
  Top Fit Score: 92/100

TOP 10 OPPORTUNITIES (Ranked by Fit):
------------------------------------------------------------

1. Senior AI Engineer @ Plaid
   Fit Score: 92/100
   URL: https://plaid.com/careers/ai-engineer
   Company: https://plaid.com
   Funding: YC S12
   Remote: 100% remote
   Contract-Friendly: Yes
```

**Requirements**:
- Uses Groq Compound model with built-in web search (no additional API keys needed)
- Groq automatically searches the web, visits career pages, and extracts job postings
- Uses Groq LLM for AI-powered analysis and ranking

## How It Works

### Semantic Alignment Architecture

**1. JD Analysis**
- Extracts key requirements from job descriptions (skills, technologies, responsibilities)
- Prioritizes "Responsibilities" and "Qualifications" sections
- Identifies core competencies needed

**2. Experience Mapping**
- Analyzes your resume bullet points
- Maps each bullet to relevant JD requirements
- Identifies which bullets can demonstrate alignment

**3. Strategic Rephrasing**
- Rewrites bullets to emphasize alignment with JD requirements
- Focuses on demonstrating **similar responsibilities managed**, not just skills possessed
- Maintains factual accuracy (numbers, achievements unchanged)

**4. Formatting Preservation**
- Uses Google Docs API `replaceAllText` to preserve all formatting
- Bullets, headers, styling remain intact
- Only text content changes

**5. Version Control**
- Creates new Google Drive revision for each update
- Tracks metadata (company, job title, URL) in local `resume_versions.json`
- Enables easy revert and export

### Example Alignment

**Job Description requires**: "Building and scaling advanced ML/AI systems that power core products"

**Original resume bullet**:
> "AI Expansion: Developed and launched two full-stack AI applications integrated with Stripe, generating $80K in the first 40 days and expanding the company's reach into enterprise AI education."

**Aligned bullet**:
> "Built and Scaled AI Systems: Developed and launched two full-stack AI applications integrated with Stripe, generating $80K in the first 40 days, and powering core product features through AI expansion."

**Why it works**: Rephrases to emphasize "building and scaling AI systems" (matching JD language) while keeping all facts intact.

## Metadata Extraction

The tool automatically extracts company and job title information from URLs and job descriptions:

### URL-Based Extraction

**Regular company domains**:
- `careers.tavant.com` → Company: "Tavant"
- `work.mercor.com` → Company: "Mercor"
- `jobs.apple.com` → Company: "Apple"

**Job board platforms**:
- `job-boards.eu.greenhouse.io/agency/jobs/123` → Company extracted from JD content
- `lever.co/company/role` → Company extracted from JD content

**Job title extraction**:
- Extracted from URL path (last meaningful segment)
- Falls back to JD content if URL doesn't contain title

### JD Content Extraction

When URL extraction doesn't find company/job title, the tool searches JD content for:
- Company name patterns: "Company Logo", "at Company", "Join Company"
- Job title patterns: First H1 header, title case text

### Manual Override

You can always override auto-extraction:

```bash
npm start -- update --jd-url "https://jobs.company.com/role" --company "Correct Company" --job-title "Correct Title"
```

## Features

### Core Features

- ✅ **Semantic alignment** with job descriptions (not just word swaps)
- ✅ **Formatting preservation** - all bullets, headers, and styling remain intact
- ✅ **Word count constraint** - updates never exceed original word count (within 5 words)
- ✅ **Google Drive integration** - single source of truth with revision history
- ✅ **Version tracking** - local JSON log with desync detection
- ✅ **Dry-run mode** - preview changes before applying

### Advanced Features

- ✅ **URL-based JD extraction** - extract job descriptions directly from URLs
- ✅ **Batch processing** - process multiple job URLs automatically
- ✅ **Company monitoring** - automatically discover jobs from career pages
- ✅ **Metadata tagging** - auto-extract and tag versions with company/job info
- ✅ **Version export** - download resume versions as PDF or DOCX
- ✅ **Search and filter** - find specific versions by company, job, or keywords
- ✅ **Smart metadata extraction** - handles various URL patterns and job board platforms
- ✅ **Job sourcing** - AI-powered discovery of opportunities from YC companies and Series A/B startups

## File Structure

```
resume-agent/
├── src/
│   ├── main.ts          # CLI entry point and command handlers
│   ├── config.ts        # Environment configuration
│   ├── types.ts         # TypeScript interfaces
│   ├── googleDrive.ts   # Google Drive/Docs API client
│   ├── groqClient.ts    # Groq API client for semantic alignment
│   └── monitor.ts       # Company monitoring service
├── companies.json       # Company monitoring configuration (create from .example)
├── jobs_queue.json      # Discovered jobs queue (auto-generated)
├── resume_versions.json # Version log with metadata (auto-generated)
├── exports/             # Exported resume versions (auto-created)
└── .env                 # Environment variables (not in git)
```

## Troubleshooting

### "FIRECRAWL_API_KEY is required"

**Solution**: Add `FIRECRAWL_API_KEY` to your `.env` file. Required for `--jd-url` and batch processing.

### "Invalid URL format"

**Solution**: Ensure URLs start with `http://` or `https://` and are properly formatted.

### "Company name extracted incorrectly"

**Solution**: 
1. Use `--company` flag to override
2. Or use `tag` command to correct metadata after update

### "No changes found" or "Skipped: Word count difference too large"

**Solution**: This is normal. The tool only suggests changes that:
- Align with JD requirements
- Maintain similar word count (within 5 words)
- Don't change factual content

If no changes are suggested, your resume may already be well-aligned, or the JD requirements don't match your experience.

### "Permission denied" when accessing Google Doc

**Solution**: Ensure you've shared the Google Doc with the service account email (found in your JSON key file) as **Editor**.

### Batch processing stops on error

**Solution**: This is expected behavior. The tool continues processing remaining URLs even if one fails. Check the error message for the specific URL that failed.

### Job sourcing returns no results

**Solution**: Groq Compound model uses web search to find opportunities. If no results are found, try:
- Check your internet connection
- Verify your Groq API key is valid
- The search may take longer for comprehensive results (Groq performs multiple web searches)

## Design Principles

### Core Invariants (Never Change)

- **Single source of truth**: Google Doc remains the authoritative resume
- **Formatting preservation**: All formatting, styling, and structure preserved
- **Semantic alignment**: Focus on demonstrating similar responsibilities, not keyword stuffing
- **Word count constraints**: Updates maintain similar length (within 5 words)

### Implementation Constraints

- **Simple codebase**: ~800 LOC total, functions <50 lines
- **Minimal dependencies**: Only essential packages
- **TypeScript strict mode**: No `any` types, Zod for validation
- **Error handling**: Basic try-catch, clear error messages

## Roadmap

### ✅ Phase 1: URL-Based JD Extraction (Completed)
- Extract job descriptions from URLs
- Auto-extract metadata (company, job title)
- Support for various URL patterns and job boards

### ✅ Phase 2: Batch Resume Creation System (Completed)
- Batch processing multiple job URLs
- Company monitoring and job discovery
- Version tagging and metadata management
- Export functionality (PDF/DOCX)
- Search and filtering capabilities

### Future Enhancements (Not Yet Implemented)

- **Chrome Extension**: One-click resume update from job posting pages
- **Web Application**: Centralized management interface
- **Multi-resume Support**: Different resumes for different roles
- **ATS Optimization**: Suggestions for ATS-friendly formatting

## Contributing

This is an MVP focused on simplicity and reliability. Contributions should:
- Maintain the core invariants
- Keep functions under 50 lines
- Use strict TypeScript
- Follow existing error handling patterns
- Add tests via console.log (no Jest)

## License

MIT
