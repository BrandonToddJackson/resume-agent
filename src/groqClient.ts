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
 * Build prompt for semantic alignment with job description
 */
function buildReplacementPrompt(resumeText: string, jobDescription: string): string {
  return `You are an expert resume consultant. Your job is to align resume bullet points with job description requirements.

## JOB DESCRIPTION:
${jobDescription}

## CURRENT RESUME:
${resumeText}

## YOUR TASK:
1. First, identify the KEY REQUIREMENTS from the job description (skills, technologies, responsibilities)
2. For each resume bullet point, determine which JD requirement it best demonstrates
3. Rephrase bullet points to EMPHASIZE the relevant skill/experience that matches the JD
4. Keep the same factual content - only change HOW it's presented to highlight JD alignment

## RULES:
- Replace FULL bullet points or sentences, not individual words
- Keep the EXACT same facts/numbers - don't add or remove achievements
- Original and replacement must have similar word count (within 5 words)
- Focus on bullets that CAN be aligned with JD requirements
- If a bullet doesn't relate to the JD, don't suggest changing it
- Maximum 8 replacements (focus on highest-impact changes)

## EXAMPLE:
JD requires: "Experience building AI systems"
Resume bullet: "Built two full-stack applications integrated with Stripe"
Better version: "Architected two full-stack AI applications with payment integration"
(Emphasizes "AI" and "architected" to match JD language)

Return JSON:
{
  "replacements": [
    {
      "original": "exact text of the original bullet or sentence from resume",
      "replacement": "rephrased version emphasizing JD-relevant skills",
      "jd_alignment": "which JD requirement this addresses"
    }
  ],
  "summary": ["Brief description of alignment strategy"]
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
  console.log('Analyzing job description requirements...');
  console.log('Identifying resume sections to align...');
  
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
    
    // Word count check: replacement shouldn't be drastically different
    const origWords = r.original.split(/\s+/).length;
    const replWords = r.replacement.split(/\s+/).length;
    if (Math.abs(origWords - replWords) > 8) {
      console.log(`  Skipped: Word count difference too large (${origWords} → ${replWords})`);
      return false;
    }
    
    return true;
  });
  
  console.log(`\nFound ${validReplacements.length} semantic alignments`);
  
  // Log JD alignment info
  for (const r of validReplacements) {
    if (r.jd_alignment) {
      console.log(`  → Aligns with: "${r.jd_alignment}"`);
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

