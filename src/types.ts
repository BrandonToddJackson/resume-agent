/**
 * Google Drive revision metadata
 */
export interface Revision {
  id: string;
  modifiedTime: string;
  mimeType: string;
}

/**
 * Local version log entry stored in resume_versions.json
 */
export interface VersionLogEntry {
  revisionId: string;
  timestamp: string;
  jobTitle?: string;
  company?: string;
  jobUrl?: string;
  changes: string[];
  isRevert: boolean;
}

/**
 * LLM response structure for resume updates
 */
export interface ResumeUpdateResponse {
  updatedText: string;
  changes: string[];
}

