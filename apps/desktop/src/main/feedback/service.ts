import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import {
  FEEDBACK_IMAGE_MIME_TYPES,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_EMAIL_LENGTH,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_TEXT_LENGTH,
  type FeedbackImageInput,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResult,
} from '../../shared/feedback.js';
import type { LogEvent } from '../runtime/log-parser.js';
import { createTelegramBotClient, type TgUpload } from '../telegram/bot-api.js';
import type { FeedbackTelegramConfig } from './config.js';
import {
  buildFeedbackDiagnosticLog,
  FEEDBACK_DIAGNOSTIC_MAX_BYTES,
} from './diagnostic-log.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_DIAGNOSTIC_BYTES = 256;

class FeedbackValidationError extends Error {}

type PreparedFeedbackRequest = {
  feedback: string;
  contactEmail: string;
  images: TgUpload[];
  imageBytes: number;
  includeDiagnosticLogs: boolean;
};

function safeFilename(name: string, fallback: string): string {
  const leaf = name.replace(/\\/g, '/').split('/').pop()?.trim() || fallback;
  return leaf.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || fallback;
}

function decodeImage(image: FeedbackImageInput, index: number): TgUpload {
  if (!FEEDBACK_IMAGE_MIME_TYPES.includes(image.mimeType)) {
    throw new FeedbackValidationError(`Image ${index + 1} has an unsupported format.`);
  }
  if (!Number.isSafeInteger(image.size) || image.size <= 0) {
    throw new FeedbackValidationError(`Image ${index + 1} has an invalid size.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64) || image.dataBase64.length % 4 !== 0) {
    throw new FeedbackValidationError(`Image ${index + 1} contains invalid data.`);
  }
  const bytes = Buffer.from(image.dataBase64, 'base64');
  if (bytes.byteLength !== image.size) {
    throw new FeedbackValidationError(`Image ${index + 1} size does not match its data.`);
  }
  return {
    data: new Uint8Array(bytes),
    filename: safeFilename(image.name, `feedback-image-${index + 1}`),
    mimeType: image.mimeType,
  };
}
export function validateFeedbackRequest(request: unknown): PreparedFeedbackRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new FeedbackValidationError('Invalid feedback request.');
  }
  const raw = request as Partial<FeedbackSubmitRequest>;
  const feedback = typeof raw.feedback === 'string' ? raw.feedback.trim() : '';
  const contactEmail = typeof raw.contactEmail === 'string' ? raw.contactEmail.trim() : '';
  if (!feedback) throw new FeedbackValidationError('Please enter some feedback before sending.');
  if (feedback.length > FEEDBACK_MAX_TEXT_LENGTH) {
    throw new FeedbackValidationError(`Feedback must be ${FEEDBACK_MAX_TEXT_LENGTH.toLocaleString()} characters or fewer.`);
  }
  if (contactEmail.length > FEEDBACK_MAX_EMAIL_LENGTH || (contactEmail && !EMAIL_PATTERN.test(contactEmail))) {
    throw new FeedbackValidationError('Enter a valid contact email or leave it blank.');
  }
  if (!Array.isArray(raw.images)) throw new FeedbackValidationError('Invalid image attachments.');
  if (raw.images.length > FEEDBACK_MAX_IMAGES) {
    throw new FeedbackValidationError(`Attach no more than ${FEEDBACK_MAX_IMAGES} images.`);
  }
  const images = raw.images.map((image, index) => decodeImage(image, index));
  const imageBytes = images.reduce((total, image) => total + image.data.byteLength, 0);
  if (imageBytes > FEEDBACK_MAX_ATTACHMENT_BYTES) {
    throw new FeedbackValidationError('Attachments exceed the 8 MiB total limit.');
  }
  return {
    feedback,
    contactEmail,
    images,
    imageBytes,
    includeDiagnosticLogs: raw.includeDiagnosticLogs === true,
  };
}

export function formatFeedbackMessage(input: {
  feedbackId: string;
  feedback: string;
  contactEmail: string;
  appVersion: string;
  platform: string;
  imageCount: number;
  diagnosticStatus: 'included' | 'omitted' | 'not requested';
}): string {
  const metadata = [
    input.contactEmail ? `Contact: ${input.contactEmail}` : null,
    `AntSeed VPR: ${input.appVersion}`,
    `Platform: ${input.platform}`,
    `Images: ${input.imageCount}`,
    `Diagnostic logs: ${input.diagnosticStatus}${input.diagnosticStatus === 'included' ? ' (privacy-redacted)' : ''}`,
  ].filter((line): line is string => Boolean(line));
  return [`AntSeed Feedback · ${input.feedbackId}`, '', input.feedback, '', ...metadata].join('\n');
}

export async function submitTelegramFeedback(input: {
  config: FeedbackTelegramConfig;
  request: unknown;
  logs: readonly LogEvent[];
  appVersion: string;
}): Promise<FeedbackSubmitResult> {
  let prepared: PreparedFeedbackRequest;
  try {
    prepared = validateFeedbackRequest(input.request);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof FeedbackValidationError ? error.message : 'Invalid feedback request.',
    };
  }

  const feedbackId = randomUUID().slice(0, 8).toUpperCase();
  const warnings: string[] = [];
  let diagnosticLog: TgUpload | null = null;
  if (prepared.includeDiagnosticLogs) {
    const remainingBytes = FEEDBACK_MAX_ATTACHMENT_BYTES - prepared.imageBytes;
    if (remainingBytes < MIN_DIAGNOSTIC_BYTES) {
      warnings.push('Diagnostic logs were omitted because the images use the attachment limit.');
    } else {
      const data = buildFeedbackDiagnosticLog(
        input.logs,
        Math.min(remainingBytes, FEEDBACK_DIAGNOSTIC_MAX_BYTES),
      );
      diagnosticLog = {
        data,
        filename: `antseed-diagnostics-${feedbackId.toLowerCase()}.txt`,
        mimeType: 'text/plain',
      };
    }
  }

  const content = formatFeedbackMessage({
    feedbackId,
    feedback: prepared.feedback,
    contactEmail: prepared.contactEmail,
    appVersion: input.appVersion,
    platform: `${process.platform} ${process.arch} ${release()}`,
    imageCount: prepared.images.length,
    diagnosticStatus: diagnosticLog ? 'included' : prepared.includeDiagnosticLogs ? 'omitted' : 'not requested',
  });
  const client = createTelegramBotClient(input.config.botToken);
  let rootMessageId: number;
  try {
    const root = await client.sendMessage(input.config.chatId, content);
    rootMessageId = root.message_id;
  } catch (error) {
    console.error('[feedback] Failed to send Telegram feedback:', error instanceof Error ? error.message : String(error));
    return { ok: false, error: 'Unable to send feedback. Please try again.' };
  }

  if (prepared.images.length > 0) {
    try {
      const options = { caption: `Feedback ${feedbackId}`, replyToMessageId: rootMessageId };
      if (prepared.images.length === 1) {
        await client.sendPhoto(input.config.chatId, prepared.images[0]!, options);
      } else {
        await client.sendMediaGroup(input.config.chatId, prepared.images, options);
      }
    } catch (error) {
      console.error('[feedback] Telegram accepted feedback but rejected image attachments:', error instanceof Error ? error.message : String(error));
      warnings.push('Feedback was sent, but the image attachments could not be uploaded.');
    }
  }

  if (diagnosticLog) {
    try {
      await client.sendDocument(input.config.chatId, diagnosticLog, {
        caption: `Feedback ${feedbackId} · privacy-redacted diagnostics`,
        replyToMessageId: rootMessageId,
      });
    } catch (error) {
      console.error('[feedback] Telegram accepted feedback but rejected diagnostic logs:', error instanceof Error ? error.message : String(error));
      warnings.push('Feedback was sent, but the diagnostic log could not be uploaded.');
    }
  }

  return {
    ok: true,
    feedbackId,
    ...(warnings.length > 0 ? { attachmentWarnings: warnings } : {}),
  };
}
