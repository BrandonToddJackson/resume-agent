# Resume Agent MVP

CLI tool that uses AI to semantically align your Google Doc resume with job descriptions. Instead of superficial word replacements, it intelligently maps JD requirements to your experience and rephrases bullet points to highlight relevant skills.

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Configure `.env`:
- `GROQ_API_KEY`: Your Groq API key
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to Google service account JSON key
- `RESUME_FILE_ID`: Your Google Doc file ID (from URL)

4. Share your Google Doc with the service account email (found in the JSON key file) as Editor.

## Usage

### Update resume
```bash
# Use -- after npm start to pass arguments correctly
npm start -- update --jd "Software engineer with TypeScript experience"
npm start -- update --jd-file path/to/jd.txt
npm start -- update --jd "job description text" --dry-run

# Alternative: Call tsx directly (no -- needed)
npx tsx src/main.ts update --jd "Software engineer with TypeScript experience"
npx tsx src/main.ts update --jd-file path/to/jd.txt
npx tsx src/main.ts update --jd "job description text" --dry-run
```

**Note**: The `--` after `npm start` is required to pass arguments correctly. Without it, npm may strip quotes from multi-word job descriptions.

### List versions
```bash
npm start list
```

### Revert to version
```bash
npm start revert 0  # By index
npm start revert <revisionId>  # By revision ID
```

## How It Works

**Semantic Alignment Architecture:**
1. **JD Analysis**: Extracts key requirements from job descriptions (skills, technologies, responsibilities)
2. **Experience Mapping**: Identifies which resume bullets demonstrate relevant JD requirements
3. **Strategic Rephrasing**: Rewrites bullets to emphasize alignment with JD (not just synonym swaps)
4. **Formatting Preservation**: Uses Google Docs API `replaceAllText` to preserve all formatting

**Example:**
- **JD requires**: "AI systems building experience"
- **Original bullet**: "Launched AI Demystified and developed two full-stack applications..."
- **Aligned bullet**: "Built two full-stack AI applications with payment integration..."
- **Why**: Emphasizes "AI" and "built" to match JD language while keeping facts intact

## Features

- **Semantic alignment** with job descriptions (not just word swaps)
- **Formatting preservation** - all bullets, headers, and styling remain intact
- **Word count constraint** - updates never exceed original word count
- **Google Drive integration** - single source of truth with revision history
- **Version tracking** - local JSON log with desync detection
- **Dry-run mode** - preview changes before applying
- **Full JD support** - works with multi-paragraph job descriptions

## Roadmap

### Phase 1: URL-Based JD Extraction (Next)
**Goal**: Extract job descriptions directly from URLs

**Implementation**:
- Add `--jd-url` flag to CLI
- Integrate Firecrawl API to scrape job posting pages
- Convert HTML → Markdown → JD text
- Reuse existing semantic alignment logic

**Why First**: Simplest extension of current CLI, validates JD extraction before building browser integration

**Example**:
```bash
npm start -- update --jd-url "https://jobs.company.com/ai-engineer"
```

---

### Phase 2: Chrome Extension (MVP)
**Goal**: One-click resume update from any job posting page

**Architecture**:
- **Extension Popup**: Extract JD from current page DOM
- **Background Service**: Send JD to resume agent API
- **CLI as API**: Expose HTTP server mode (REST API wrapper around CLI)
- **Auto-detect**: Identify job description sections on common sites (LinkedIn, Indeed, etc.)

**Core Components**:
1. Content script to extract JD text from page
2. Extension popup with "Update Resume" button
3. CLI server mode (`npm start server`) for extension to call
4. Simple auth (API key) for extension → CLI communication

**Why Second**: Validates browser integration before building full web app

---

### Phase 3: Web Application
**Goal**: Centralized management interface for resume updates

**Features**:
- Dashboard showing update history
- Job description library (saved JDs with alignment results)
- Resume preview with diff view
- Settings (API keys, Google Doc selection)
- Batch updates (test multiple JDs)

**Architecture**:
- **Frontend**: React/Next.js (simple, modern UI)
- **Backend**: FastAPI/Express (thin API layer over CLI logic)
- **Database**: SQLite/PostgreSQL (job descriptions, update history)
- **Auth**: Simple API key or OAuth

**Why Third**: Provides management layer after core functionality is validated

---

### Phase 4: Full Integration
**Goal**: Seamless browser → web app → resume update flow

**Enhancements**:
- Extension syncs with web app account
- Real-time updates in web app when extension triggers
- Multi-resume support (different resumes for different roles)
- ATS optimization suggestions
- Analytics (which JDs led to interviews)

**Why Last**: Requires all previous phases to be stable

---

### Design Principles (from First Principles)

**Core Invariants** (never change):
- Single source of truth (Google Doc)
- Formatting preservation
- Semantic alignment (not word swaps)
- Word count constraints

**What We're Adding** (not changing):
- New input methods (URL, browser extraction)
- New interfaces (extension, web app)
- New storage (JD library, history)

**Constraints** (from .cursorrules):
- Keep core logic simple (~600-800 LOC)
- Minimal dependencies
- TypeScript strict mode
- Functions <50 lines

**Simplest Path Forward**:
1. URL extraction (adds one dependency: Firecrawl)
2. Extension (reuses CLI as API, minimal new code)
3. Web app (separate repo, calls CLI API)
4. Integration (connect pieces)

This progression validates each component independently before building the next layer.

