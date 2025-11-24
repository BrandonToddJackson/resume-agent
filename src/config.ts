import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Configuration schema validation
 */
const ConfigSchema = z.object({
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1, 'GOOGLE_APPLICATION_CREDENTIALS is required'),
  RESUME_FILE_ID: z.string().min(1, 'RESUME_FILE_ID is required'),
});

/**
 * Validated configuration object
 */
export const config = ConfigSchema.parse({
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  RESUME_FILE_ID: process.env.RESUME_FILE_ID,
});

