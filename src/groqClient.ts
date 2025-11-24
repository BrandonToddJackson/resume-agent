import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';

/**
 * Export type for word replacements (used by googleDrive.ts)
 */
export interface ReplacementItem {
  original: string;
  replacement: string;
}

/**
 * Response type for resume update
 */
export interface ResumeUpdateResult {
  replacements: ReplacementItem[];
  changes: string[];
}

/**
 * Zod schema for LLM alignment suggestions
 */
const AlignmentSchema = z.object({
  replacements: z.array(
    z.object({
      original: z.string().describe('Original bullet point or sentence'),
      replacement: z.string().describe('Rephrased version aligned with JD'),
      jd_alignment: z.string().optional().describe('Which JD requirement this addresses'),
    })
  ).min(1).max(10),
  summary: z.array(z.string()).min(1).max(5).describe('Summary of alignment strategy'),
});

type AlignmentResponse = z.infer<typeof AlignmentSchema>;

/**
 * Extract and prioritize Responsibilities and Qualifications from job description
 */
function extractKeySections(jobDescription: string): {
  responsibilities: string;
  qualifications: string;
  fullJD: string;
} {
  // Find Responsibilities section
  const respMatch = jobDescription.match(
    /##?\s*Responsibilities?\s*\n([\s\S]*?)(?=\n##?\s*(?:Qualifications?|Requirements?|About|Company|$))/i
  );
  const responsibilities = respMatch && respMatch[1] ? respMatch[1].trim() : '';
  
  // Find Qualifications section
  const qualMatch = jobDescription.match(
    /##?\s*Qualifications?\s*\n([\s\S]*?)(?=\n##?\s*(?:Responsibilities?|Requirements?|About|Company|Salary|$))/i
  );
  const qualifications = qualMatch && qualMatch[1] ? qualMatch[1].trim() : '';
  
  // If sections not found, try alternative patterns
  const altRespMatch = !responsibilities && jobDescription.match(
    /(?:What you'll do|Key Responsibilities|You will|You'll)\s*[:\-]?\s*\n([\s\S]*?)(?=\n(?:Qualifications?|Requirements?|What you bring|$))/i
  );
  const altQualMatch = !qualifications && jobDescription.match(
    /(?:Qualifications?|Requirements?|What you bring|You have)\s*[:\-]?\s*\n([\s\S]*?)(?=\n(?:Responsibilities?|Salary|About|$))/i
  );
  
  return {
    responsibilities: responsibilities || (altRespMatch && altRespMatch[1] ? altRespMatch[1].trim() : ''),
    qualifications: qualifications || (altQualMatch && altQualMatch[1] ? altQualMatch[1].trim() : ''),
    fullJD: jobDescription,
  };
}

/**
 * Build prompt for semantic alignment with job description using first-principles approach
 */
function buildReplacementPrompt(resumeText: string, jobDescription: string): string {
  const sections = extractKeySections(jobDescription);
  
  // Build prioritized JD content
  let prioritizedJD = '';
  if (sections.responsibilities) {
    prioritizedJD += `## CRITICAL: RESPONSIBILITIES (Highest Priority)
${sections.responsibilities}

`;
  }
  if (sections.qualifications) {
    prioritizedJD += `## CRITICAL: QUALIFICATIONS (Highest Priority)
${sections.qualifications}

`;
  }
  if (sections.responsibilities || sections.qualifications) {
    prioritizedJD += `## FULL JOB DESCRIPTION (Reference)
${sections.fullJD}`;
  } else {
    prioritizedJD = `## JOB DESCRIPTION:
${jobDescription}`;
  }

  return `You are an expert resume consultant using first-principles thinking. Your goal is to show that the candidate has MANAGED SIMILAR RESPONSIBILITIES, not just add keywords.

${prioritizedJD}

## CURRENT RESUME:
${resumeText}

## FIRST-PRINCIPLES ANALYSIS:

### Step 1: Identify Core Responsibilities
From the Responsibilities section above, extract the FUNDAMENTAL DUTIES:
- What must this person actually DO in this role?
- What outcomes must they deliver?
- What systems/processes must they manage?

### Step 2: Map Experience to Responsibilities
For each resume bullet, ask:
- Does this experience demonstrate managing a SIMILAR responsibility?
- Can this bullet be rephrased to show we've done equivalent work?
- What's the CORE FUNCTION this bullet demonstrates?

### Step 3: Rephrase to Show Responsibility Match
Rephrase bullets to:
- Lead with the RESPONSIBILITY/DUTY (not just the action)
- Show you've managed similar outcomes
- Use language that mirrors the JD's responsibility descriptions
- Keep ALL facts, numbers, and achievements intact

## CRITICAL RULES:

1. **Responsibility-First Approach**: 
   - Don't just add keywords at the end
   - Rephrase to show you've managed similar responsibilities
   - Example: If JD says "Building and scaling ML/AI systems", show your bullet demonstrates you've built and scaled systems (even if not ML/AI)

2. **Word Count Constraint**: 
   - Original and replacement must be within 5 words of each other
   - This means REPHRASING, not adding phrases
   - Remove less important words to make room for responsibility-focused language

3. **Factual Integrity**:
   - Keep EXACT same facts, numbers, achievements
   - Only change HOW it's presented
   - Never fabricate or exaggerate

4. **Prioritization**:
   - Focus on bullets that match RESPONSIBILITIES first
   - Then match QUALIFICATIONS
   - Ignore bullets that don't relate to core duties

## EXAMPLES OF GOOD ALIGNMENT:

**JD Responsibility**: "Building and scaling advanced ML/AI systems that power core products"

**Bad (just adding keywords)**:
- Original: "Built two full-stack applications"
- Bad: "Built two full-stack applications, demonstrating experience with ML/AI systems" ❌

**Good (showing responsibility match)**:
- Original: "Built two full-stack applications integrated with Stripe, generating $80K in first 40 days"
- Good: "Built and scaled two full-stack AI applications integrated with Stripe, generating $80K in first 40 days and powering core product features" ✅
- Why: Shows "building and scaling" (the responsibility) and "powering products" (the outcome)

**JD Responsibility**: "Driving impact at scale by improving distributed training, serving, and ML operations"

**Bad (just adding keywords)**:
- Original: "Delivered database migration 3 months early"
- Bad: "Delivered database migration 3 months early, utilizing distributed systems and ML operations" ❌

**Good (showing responsibility match)**:
- Original: "Delivered database migration 3 months early by scripting automated data quality fixes in Python, eliminating critical defects for 5,000+ users"
- Good: "Improved distributed data operations at scale, delivering database migration 3 months early through automated Python scripts that eliminated critical defects for 5,000+ users" ✅
- Why: Leads with "improved...operations at scale" (the responsibility) and shows similar outcomes

## YOUR TASK:

1. Analyze the Responsibilities section to identify core duties
2. For each resume bullet, determine if it demonstrates managing a similar responsibility
3. Rephrase bullets to LEAD with the responsibility/duty, showing you've done equivalent work
4. Keep word count within 5 words of original
5. Maximum 8 replacements (focus on highest-impact responsibility matches)

Return JSON:
{
  "replacements": [
    {
      "original": "exact text of the original bullet from resume",
      "replacement": "rephrased version that shows you've managed similar responsibilities",
      "jd_alignment": "specific responsibility from JD that this matches"
    }
  ],
  "summary": ["Brief description of how resume demonstrates managing similar responsibilities"]
}`;
}



/**
 * Get semantic alignment suggestions from LLM
 */
async function getAlignmentSuggestions(
  resumeText: string,
  jobDescription: string
): Promise<AlignmentResponse> {
  const prompt = buildReplacementPrompt(resumeText, jobDescription);
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Use a more capable model for semantic understanding
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            Authorization: `Bearer ${config.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const content = response.data.choices[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new Error('Invalid response format from Groq API');
      }

      const parsed = JSON.parse(content);
      
      // Truncate arrays if needed
      if (parsed.replacements && parsed.replacements.length > 10) {
        parsed.replacements = parsed.replacements.slice(0, 10);
      }
      if (parsed.summary && parsed.summary.length > 5) {
        parsed.summary = parsed.summary.slice(0, 5);
      }
      
      return AlignmentSchema.parse(parsed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Better error handling for API errors
      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;
        const data = error.response.data;
        throw new Error(`Groq API Error ${status}: ${data?.error?.message || error.message}`);
      }
      
      // Retry on JSON/parse errors
      const isRetryable = attempt < maxRetries && 
        (lastError.message.includes('JSON') || lastError.message.includes('parse'));
      
      if (!isRetryable) {
        throw lastError;
      }
      
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw lastError || new Error('Failed to get alignment suggestions');
}

/**
 * Get semantic alignment replacements for a job description
 * Returns full sentence/bullet replacements aligned with JD requirements
 */
export async function getResumeReplacements(
  resumeText: string,
  jobDescription: string
): Promise<ResumeUpdateResult> {
  console.log('Analyzing job description using first-principles approach...');
  
  const sections = extractKeySections(jobDescription);
  if (sections.responsibilities) {
    console.log('✓ Extracted Responsibilities section (highest priority)');
  }
  if (sections.qualifications) {
    console.log('✓ Extracted Qualifications section (high priority)');
  }
  console.log('Mapping resume experience to core responsibilities...');
  
  const suggestions = await getAlignmentSuggestions(resumeText, jobDescription);
  
  // Filter and validate replacements
  const validReplacements = suggestions.replacements.filter((r) => {
    // Must exist in the text
    if (!resumeText.includes(r.original)) {
      console.log(`  Skipped: "${r.original.substring(0, 40)}..." (not found in resume)`);
      return false;
    }
    
    // Must be different
    if (r.original.trim() === r.replacement.trim()) {
      return false;
    }
    
    // Word count check: replacement shouldn't be drastically different (within 5 words as per prompt)
    const origWords = r.original.split(/\s+/).length;
    const replWords = r.replacement.split(/\s+/).length;
    if (Math.abs(origWords - replWords) > 5) {
      console.log(`  Skipped: Word count difference too large (${origWords} → ${replWords}, max 5 allowed)`);
      return false;
    }
    
    return true;
  });
  
  console.log(`\nFound ${validReplacements.length} responsibility-aligned updates`);
  
  // Log JD alignment info with responsibility focus
  for (const r of validReplacements) {
    if (r.jd_alignment) {
      console.log(`  → Demonstrates managing: "${r.jd_alignment}"`);
    }
  }
  
  return {
    replacements: validReplacements.map((r) => ({
      original: r.original,
      replacement: r.replacement,
    })),
    changes: suggestions.summary,
  };
}

