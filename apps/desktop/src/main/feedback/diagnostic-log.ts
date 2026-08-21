import type { LogEvent } from '../runtime/log-parser.js';

export const FEEDBACK_DIAGNOSTIC_MAX_ENTRIES = 500;
export const FEEDBACK_DIAGNOSTIC_MAX_BYTES = 512 * 1024;

type RedactionCategory =
  | 'TOKEN'
  | 'SECRET'
  | 'WEBHOOK'
  | 'EMAIL'
  | 'HOME'
  | 'IP'
  | 'WALLET'
  | 'PEER';

class StableRedactor {
  private readonly values = new Map<string, string>();
  private readonly counts = new Map<RedactionCategory, number>();

  private placeholder(category: RedactionCategory, value: string): string {
    const key = `${category}:${value.toLowerCase()}`;
    const existing = this.values.get(key);
    if (existing) return existing;
    const next = (this.counts.get(category) ?? 0) + 1;
    this.counts.set(category, next);
    const placeholder = `<${category}_${next}>`;
    this.values.set(key, placeholder);
    return placeholder;
  }

  redact(input: string): string {
    let output = input;
    output = output.replace(
      /https?:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/\S+/gi,
      (value) => this.placeholder('WEBHOOK', value),
    );
    output = output.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, (value) => this.placeholder('TOKEN', value));
    output = output.replace(/\bBearer\s+[^\s,;]+/gi, (value) => `Bearer ${this.placeholder('TOKEN', value)}`);
    output = output.replace(
      /\b(api[_-]?key|token|secret|password|private[_-]?key|authorization)(\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, key: string, separator: string, value: string) => `${key}${separator}${this.placeholder('SECRET', value)}`,
    );
    output = output.replace(/\b0x[0-9a-f]{64}\b/gi, (value) => this.placeholder('SECRET', value));
    output = output.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (value) => this.placeholder('EMAIL', value));
    output = output.replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/gi, (value) => this.placeholder('HOME', value));
    output = output.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, (value) => this.placeholder('IP', value));
    output = output.replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}(?::\d{1,5})?\b/gi, (value) => this.placeholder('IP', value));
    output = output.replace(/\b0x[0-9a-f]{40}\b/gi, (value) => this.placeholder('WALLET', value));
    output = output.replace(/\b[0-9a-f]{40}\b/gi, (value) => this.placeholder('PEER', value));
    return output;
  }
}

function formatEntry(entry: LogEvent, redactor: StableRedactor): string {
  const timestamp = new Date(entry.timestamp).toISOString();
  return `${timestamp} [${entry.mode}] [${entry.stream}] ${redactor.redact(entry.line)}`;
}

export function buildFeedbackDiagnosticLog(
  logs: readonly LogEvent[],
  maxBytes = FEEDBACK_DIAGNOSTIC_MAX_BYTES,
): Uint8Array {
  if (maxBytes <= 0) return new Uint8Array();
  const redactor = new StableRedactor();
  const formatted = logs
    .slice(-FEEDBACK_DIAGNOSTIC_MAX_ENTRIES)
    .map((entry) => formatEntry(entry, redactor));
  const header = [
    'AntSeed diagnostic log',
    'Privacy redaction applied: secrets, identity, network, and local path values are masked.',
    '',
  ];
  const selected: string[] = [];
  let currentBytes = Buffer.byteLength(header.join('\n'), 'utf8');

  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const line = formatted[index]!;
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (currentBytes + lineBytes > maxBytes) break;
    selected.unshift(line);
    currentBytes += lineBytes;
  }

  const omitted = formatted.length - selected.length;
  const omissionLine = omitted > 0 ? `[${omitted} earlier log entries omitted]\n` : '';
  let text = `${header.join('\n')}${omissionLine}${selected.join('\n')}${selected.length > 0 ? '\n' : ''}`;
  let bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > maxBytes) {
    text = 'AntSeed diagnostic log\n[Log omitted because the remaining attachment budget was too small.]\n';
    bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  }
  return new Uint8Array(bytes);
}
