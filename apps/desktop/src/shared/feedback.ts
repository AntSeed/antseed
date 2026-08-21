export const FEEDBACK_MAX_TEXT_LENGTH = 3_000;
export const FEEDBACK_MAX_EMAIL_LENGTH = 254;
export const FEEDBACK_MAX_IMAGES = 10;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const FEEDBACK_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type FeedbackImageMimeType = (typeof FEEDBACK_IMAGE_MIME_TYPES)[number];

export type FeedbackImageInput = {
  name: string;
  mimeType: FeedbackImageMimeType;
  size: number;
  dataBase64: string;
};

export type FeedbackSubmitRequest = {
  feedback: string;
  contactEmail?: string;
  images: FeedbackImageInput[];
  includeDiagnosticLogs: boolean;
};

export type FeedbackSubmitResult = {
  ok: boolean;
  feedbackId?: string;
  attachmentWarnings?: string[];
  error?: string;
};
export type FeedbackStatus = {
  configured: boolean;
  error?: string;
};
