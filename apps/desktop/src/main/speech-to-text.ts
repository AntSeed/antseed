export type SpeechTranscribePayload = {
  dataUrl: string;
  mimeType?: string;
  language?: string;
};

export type SpeechTranscribeSuccess = {
  ok: true;
  text: string;
};

export type SpeechTranscribeFailure = {
  ok: false;
  error: string;
};

export type SpeechTranscribeResult = SpeechTranscribeSuccess | SpeechTranscribeFailure;

type WhisperFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type WhisperFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: FormData;
  },
) => Promise<WhisperFetchResponse>;

export type WhisperTranscriptionOptions = {
  apiKey?: string;
  apiKeyEnvName?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: WhisperFetch;
};

const MAX_WHISPER_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_WHISPER_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_WHISPER_MODEL = 'whisper-1';

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
]);

function cleanBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_WHISPER_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

function normalizeMimeType(value: string | undefined): string {
  const base = String(value || '').split(';')[0] ?? '';
  return base.trim().toLowerCase();
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/m4a':
      return 'm4a';
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
    case 'audio/mpga':
      return 'mpga';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
      return 'wav';
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
    default:
      return 'webm';
  }
}

function extractAudio(payload: SpeechTranscribePayload): { data: Buffer; mimeType: string } {
  if (!payload || typeof payload.dataUrl !== 'string') {
    throw new Error('Missing audio payload');
  }

  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(payload.dataUrl.trim());
  if (!match) {
    throw new Error('Audio payload must be a base64 data URL');
  }

  const mimeType = normalizeMimeType(payload.mimeType) || normalizeMimeType(match[1]);
  if (!ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported audio format: ${mimeType || 'unknown'}`);
  }

  const base64 = match[2]?.replace(/\s/g, '') || '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('Audio payload is not valid base64');
  }

  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) {
    throw new Error('Recorded audio was empty');
  }
  if (data.length > MAX_WHISPER_AUDIO_BYTES) {
    throw new Error('Recording is too large. Please keep voice notes under 25 MiB.');
  }

  return { data, mimeType };
}

function parseWhisperText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}

function cleanErrorBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
  } catch {
    // Fall through to the raw body.
  }
  return trimmed.slice(0, 300);
}

export async function transcribeWithWhisper(
  payload: SpeechTranscribePayload,
  options: WhisperTranscriptionOptions = {},
): Promise<SpeechTranscribeResult> {
  const apiKey = options.apiKey?.trim();
  const apiKeyEnvName = options.apiKeyEnvName?.trim() || 'OPENAI_API_KEY';
  if (!apiKey) {
    return {
      ok: false,
      error: `Whisper transcription needs an OpenAI API key. Set ${apiKeyEnvName} and try again.`,
    };
  }

  let audio: { data: Buffer; mimeType: string };
  try {
    audio = extractAudio(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const model = options.model?.trim() || DEFAULT_WHISPER_MODEL;
  const form = new FormData();
  const file = new Blob([audio.data], { type: audio.mimeType });
  form.append('file', file, `antstation-recording.${extensionForMimeType(audio.mimeType)}`);
  form.append('model', model);
  form.append('response_format', 'json');
  const language = payload.language?.trim();
  if (language) {
    form.append('language', language);
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${cleanBaseUrl(options.baseUrl)}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      const detail = cleanErrorBody(responseBody);
      return {
        ok: false,
        error: detail
          ? `Whisper transcription failed (${response.status}): ${detail}`
          : `Whisper transcription failed with HTTP ${response.status}`,
      };
    }

    const text = parseWhisperText(responseBody);
    if (!text) {
      return { ok: false, error: 'Whisper returned an empty transcript.' };
    }

    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
