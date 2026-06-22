import type { PeerVerificationLink } from '@antseed/node/discovery';

export type DomainSiteMetadata = {
  title?: string;
  description?: string;
  faviconUrl?: string;
};

export type DesktopVerificationLink = PeerVerificationLink & DomainSiteMetadata;

type CacheEntry = {
  fetchedAtMs: number;
  metadata: DomainSiteMetadata | null;
};

type EnrichOptions = {
  fetch?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
};

const MAX_DOMAIN_SITE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_SITE_TITLE_LENGTH = 120;
const MAX_SITE_DESCRIPTION_LENGTH = 280;
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 10 * 60 * 1000;

const metadataCache = new Map<string, CacheEntry>();
const metadataInFlight = new Map<string, Promise<DomainSiteMetadata | null>>();

function withTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('domain metadata request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Domain metadata body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Domain metadata body exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Domain metadata body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      const parsed = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    if (normalized.startsWith('#')) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    switch (normalized) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return match;
    }
  });
}

function cleanSiteText(value: string, maxLength: number): string | undefined {
  const cleaned = decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3).trimEnd()}...` : cleaned;
}

function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (;;) {
    const match = attrRe.exec(raw);
    if (!match) break;
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function findMetaContent(html: string, names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const metaRe = /<meta\s+([^>]*?)>/gi;
  for (;;) {
    const match = metaRe.exec(html);
    if (!match?.[1]) break;
    const attrs = parseTagAttributes(match[1]);
    const key = (attrs.name ?? attrs.property ?? '').trim().toLowerCase();
    if (wanted.has(key) && attrs.content) {
      return attrs.content;
    }
  }
  return undefined;
}

function findFaviconUrl(html: string, baseUrl: string): string | undefined {
  const linkRe = /<link\s+([^>]*?)>/gi;
  for (;;) {
    const match = linkRe.exec(html);
    if (!match?.[1]) break;
    const attrs = parseTagAttributes(match[1]);
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (!attrs.href || !rel.some((part) => part === 'icon' || part === 'apple-touch-icon' || part === 'shortcut')) {
      continue;
    }
    try {
      const url = new URL(attrs.href, baseUrl);
      if (url.protocol === 'https:') {
        return url.toString();
      }
    } catch {
      // Ignore malformed favicon URLs.
    }
  }
  return undefined;
}

function parseSiteMetadata(html: string, baseUrl: string): DomainSiteMetadata | null {
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? cleanSiteText(titleMatch[1], MAX_SITE_TITLE_LENGTH) : undefined;
  const description = cleanSiteText(
    findMetaContent(html, ['og:description', 'twitter:description', 'description']) ?? '',
    MAX_SITE_DESCRIPTION_LENGTH,
  );
  const faviconUrl = findFaviconUrl(html, baseUrl) ?? new URL('/favicon.ico', baseUrl).toString();
  const metadata: DomainSiteMetadata = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(faviconUrl.startsWith('https://') ? { faviconUrl } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function domainFromVerificationLink(link: PeerVerificationLink): string | null {
  if (link.kind !== 'domain') return null;
  try {
    const url = new URL(link.href);
    if (url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function fetchDomainSiteMetadata(domain: string, options: EnrichOptions): Promise<DomainSiteMetadata | null> {
  const fetchImpl = options.fetch ?? fetch;
  const { signal, cleanup } = withTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://${domain}/`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      signal,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      return null;
    }
    const baseUrl = response.url && response.url.startsWith('https://') ? response.url : `https://${domain}/`;
    return parseSiteMetadata(await readBodyWithLimit(response, MAX_DOMAIN_SITE_METADATA_BYTES), baseUrl);
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

async function getDomainSiteMetadata(domain: string, options: EnrichOptions): Promise<DomainSiteMetadata | null> {
  const nowMs = options.nowMs ?? Date.now();
  const successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const cached = metadataCache.get(domain);
  if (cached) {
    const ttlMs = cached.metadata ? successTtlMs : failureTtlMs;
    if (nowMs - cached.fetchedAtMs < ttlMs) {
      return cached.metadata;
    }
  }

  const existing = metadataInFlight.get(domain);
  if (existing) return existing;

  const promise = fetchDomainSiteMetadata(domain, options)
    .then((metadata) => {
      metadataCache.set(domain, { fetchedAtMs: options.nowMs ?? Date.now(), metadata });
      return metadata;
    })
    .finally(() => {
      metadataInFlight.delete(domain);
    });
  metadataInFlight.set(domain, promise);
  return promise;
}

export async function enrichDomainVerificationLinks(
  links: PeerVerificationLink[],
  options: EnrichOptions = {},
): Promise<DesktopVerificationLink[]> {
  return Promise.all(links.map(async (link) => {
    const domain = domainFromVerificationLink(link);
    if (!domain) return link;
    const metadata = await getDomainSiteMetadata(domain, options);
    return {
      ...link,
      ...(metadata ?? {}),
    };
  }));
}
