import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Lexer } from 'marked';
import type { ChatMessage } from './chat-shared';
import { isToolResultOnlyMessage as isToolResultOnlyMessageShared } from './chat-shared';
import {
  findSensitiveChatArtifacts,
  formatArtifactLabel,
  isLikelyUnsafePaymentInstruction,
  segmentSensitiveChatText,
} from './chat-safety';
import type { SensitiveChatArtifact } from './chat-safety';

type MarkdownContentProps = {
  text: string;
  className?: string;
  highlightQuery?: string;
  activeHighlight?: boolean;
  blockUnsafePaymentInstructions?: boolean;
};

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  lang?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  ordered?: boolean;
  depth?: number;
  href?: string;
  title?: string | null;
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
  align?: Array<'center' | 'left' | 'right' | null>;
  escaped?: boolean;
  task?: boolean;
  checked?: boolean;
};

export const isToolResultOnlyMessage = isToolResultOnlyMessageShared;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function isSearchWordChar(char: string | undefined): boolean {
  return Boolean(char && /[\p{L}\p{N}_]/u.test(char));
}

export function findSearchPhraseMatches(text: string, query: string | undefined): Array<{ start: number; end: number }> {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) return [];

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = lowerText.indexOf(lowerQuery, cursor);
    if (start === -1) break;
    const end = start + trimmedQuery.length;
    const startsInsideWord = isSearchWordChar(text[start - 1]) && isSearchWordChar(text[start]);
    const endsInsideWord = isSearchWordChar(text[end - 1]) && isSearchWordChar(text[end]);

    if (!startsInsideWord && !endsInsideWord) {
      matches.push({ start, end });
    }

    cursor = end;
  }

  return matches;
}

export function hasSearchPhraseMatch(text: string, query: string | undefined): boolean {
  return findSearchPhraseMatches(text, query).length > 0;
}

function splitHighlightedText(text: string, query: string | undefined, keyPrefix: string, activeHighlight = false): ReactNode {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) return text;

  const matches = findSearchPhraseMatches(text, trimmedQuery);
  if (matches.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;

  matches.forEach((match, matchIndex) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push(
      <mark
        key={`${keyPrefix}-mark-${matchIndex}`}
        className={`chat-search-mark${activeHighlight ? ' chat-search-mark-active' : ''}`}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  });

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function securityWarning(): string {
  return 'This came from untrusted chat content. AntSeed will never ask you to send funds, deposit, top up, connect a wallet, or approve transactions from chat. Use only the official AntSeed wallet screen.';
}

function confirmUnsafeAction(action: string, target?: string): boolean {
  const targetLine = target ? `\n\nDestination:\n${target}` : '';
  return window.confirm(`${securityWarning()}\n\n${action}${targetLine}`);
}

function safeOpenExternalUrl(url: string): void {
  if (!confirmUnsafeAction('Open this external destination anyway?', url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function firstArtifactFromText(value: string): SensitiveChatArtifact | null {
  const segment = segmentSensitiveChatText(value).find((part) => part.type === 'artifact');
  return segment?.type === 'artifact' ? segment.artifact : null;
}

function HiddenWalletAddress({ artifact }: { artifact: SensitiveChatArtifact }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const value = artifact.value;
  const label = formatArtifactLabel(artifact);

  const handleReveal = (): void => {
    if (!revealed && !confirmUnsafeAction('Reveal this wallet address anyway?')) return;
    setRevealed(true);
  };

  const handleCopy = (): void => {
    if (!confirmUnsafeAction('Copy this wallet address anyway?')) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  if (!revealed) {
    return (
      <span className="chat-sensitive-artifact chat-wallet-hidden">
        <span className="chat-sensitive-label">{label}</span>
        <button type="button" className="chat-sensitive-action" onClick={handleReveal}>
          Reveal
        </button>
      </span>
    );
  }

  return (
    <span className="chat-sensitive-artifact chat-wallet-revealed">
      <code className="chat-sensitive-value">{value}</code>
      <button type="button" className="chat-sensitive-action" onClick={handleCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function SafeExternalLink({ artifact }: { artifact: SensitiveChatArtifact }) {
  const label = formatArtifactLabel(artifact);
  const isPaymentLink = artifact.type === 'url' && ['ethereum', 'bitcoin', 'solana', 'wc'].includes(artifact.scheme);

  return (
    <span className={`chat-sensitive-artifact${isPaymentLink ? ' chat-payment-link-hidden' : ' chat-external-link-gated'}`}>
      <span className="chat-sensitive-label">{label}</span>
      <button type="button" className="chat-sensitive-action" onClick={() => safeOpenExternalUrl(artifact.value)}>
        {isPaymentLink ? 'Open anyway' : 'Open with warning'}
      </button>
    </span>
  );
}

function SafeArtifact({ artifact }: { artifact: SensitiveChatArtifact; children?: ReactNode }) {
  if (artifact.type === 'wallet-address') return <HiddenWalletAddress artifact={artifact} />;
  return <SafeExternalLink artifact={artifact} />;
}

function splitSafeHighlightedText(text: string, query: string | undefined, keyPrefix: string, activeHighlight = false): ReactNode {
  const segments = segmentSensitiveChatText(text);
  if (segments.length === 1 && segments[0]?.type === 'text') {
    return splitHighlightedText(segments[0].text, query, keyPrefix, activeHighlight);
  }

  return (
    <>
      {segments.map((segment, index) => {
        const key = `${keyPrefix}-safe-${index}`;
        if (segment.type === 'text') {
          return <Fragment key={key}>{splitHighlightedText(segment.text, query, key, activeHighlight)}</Fragment>;
        }
        return <SafeArtifact key={key} artifact={segment.artifact} />;
      })}
    </>
  );
}

function BlockedUnsafePaymentInstruction() {
  return (
    <div className="chat-unsafe-payment-block" role="alert">
      <div className="chat-unsafe-payment-title">Unsafe payment instruction blocked</div>
      <div className="chat-unsafe-payment-body">
        A peer response tried to direct you to a payment, deposit, wallet, or external destination.
        AntSeed will never ask you to send funds, top up, connect a wallet, or approve transactions inside chat.
        Use only the official AntSeed wallet screen.
      </div>
    </div>
  );
}

function confirmCopyIfSensitive(text: string): boolean {
  const artifacts = findSensitiveChatArtifacts(text);
  if (artifacts.length === 0) return true;
  const addressCount = artifacts.filter((artifact) => artifact.type === 'wallet-address').length;
  const linkCount = artifacts.filter((artifact) => artifact.type === 'url').length;
  const parts = [
    addressCount > 0 ? `${addressCount} hidden address${addressCount === 1 ? '' : 'es'}` : '',
    linkCount > 0 ? `${linkCount} gated link${linkCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ');
  return confirmUnsafeAction(`This text contains ${parts}. Copy the original text anyway?`);
}

function flattenPlainText(tokens: MarkdownToken[] | undefined): string {
  if (!Array.isArray(tokens) || tokens.length === 0) return '';
  let output = '';
  for (const token of tokens) {
    if (token.type === 'br') {
      output += '\n';
      continue;
    }
    if (Array.isArray(token.tokens) && token.tokens.length > 0) {
      output += flattenPlainText(token.tokens);
      continue;
    }
    output += normalizeText(token.text ?? token.raw);
  }
  return output;
}

function renderInlineTokens(tokens: MarkdownToken[] | undefined, keyPrefix: string, highlightQuery?: string, activeHighlight = false): ReactNode[] {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  return tokens.map((token, index) => renderInlineToken(token, `${keyPrefix}-${index}`, highlightQuery, activeHighlight));
}

function renderInlineToken(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  switch (token.type) {
    case 'text':
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
      }
      return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}</Fragment>;
    case 'escape':
      return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}</Fragment>;
    case 'strong':
      return <strong key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</strong>;
    case 'em':
      return <em key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</em>;
    case 'codespan':
      return (
        <code key={key} className="chat-inline-code">
          {splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'del':
      return <del key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</del>;
    case 'link': {
      const href = normalizeText(token.href);
      const content = renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight);
      const artifact = firstArtifactFromText(href);
      if (!artifact || artifact.type !== 'url') {
        return (
          <span key={key} className="chat-inline-link-invalid">
            {content}
          </span>
        );
      }
      return <SafeArtifact key={key} artifact={artifact}>{content}</SafeArtifact>;
    }
    case 'image': {
      const href = normalizeText(token.href);
      const alt = flattenPlainText(token.tokens) || normalizeText(token.text) || 'Image';
      const artifact = firstArtifactFromText(href);
      if (!artifact || artifact.type !== 'url') {
        return (
          <span key={key} className="chat-inline-link-invalid">
            {alt}
          </span>
        );
      }
      return (
        <span key={key} className="chat-sensitive-artifact chat-external-image-hidden">
          <span className="chat-sensitive-label">External image hidden: {artifact.display}</span>
          <button type="button" className="chat-sensitive-action" onClick={() => safeOpenExternalUrl(artifact.value)}>
            Open with warning
          </button>
        </span>
      );
    }
    default:
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
      }
      return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight)}</Fragment>;
  }
}

function renderBlockTokens(tokens: MarkdownToken[], keyPrefix: string, highlightQuery?: string, activeHighlight = false): ReactNode[] {
  return tokens.map((token, index) => renderBlockToken(token, `${keyPrefix}-${index}`, highlightQuery, activeHighlight));
}

function renderTableCell(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    return <Fragment key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
  }
  return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight)}</Fragment>;
}

function renderListItemContent(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    const hasBlockTokens = token.tokens.some((child) =>
      ['paragraph', 'space', 'text', 'strong', 'em', 'codespan', 'link', 'del', 'br'].includes(child.type) === false);
    if (hasBlockTokens) {
      return <>{renderBlockTokens(token.tokens, key, highlightQuery, activeHighlight)}</>;
    }
    return <>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</>;
  }
  return splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight);
}

function CodeBlock({ code, lang, highlightQuery, activeHighlight }: { code: string; lang?: string; highlightQuery?: string; activeHighlight?: boolean }) {
  const [copied, setCopied] = useState(false);
  const langLabel = normalizeText(lang).trim() || 'code';

  const handleCopy = (): void => {
    if (!confirmCopyIfSensitive(code)) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="chat-code-container">
      <div className="chat-code-header">
        <span className="code-lang">{langLabel}</span>
        <button className="chat-code-copy-btn" type="button" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{splitSafeHighlightedText(code, highlightQuery, 'code', activeHighlight)}</code>
      </pre>
    </div>
  );
}

function renderBlockToken(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'paragraph':
      return <p key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</p>;
    case 'text':
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <p key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</p>;
      }
      return <p key={key}>{splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}</p>;
    case 'heading': {
      const depth = Math.min(Math.max(Number(token.depth) || 1, 1), 6);
      const children = renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight);
      if (depth === 1) return <h1 key={key}>{children}</h1>;
      if (depth === 2) return <h2 key={key}>{children}</h2>;
      if (depth === 3) return <h3 key={key}>{children}</h3>;
      if (depth === 4) return <h4 key={key}>{children}</h4>;
      if (depth === 5) return <h5 key={key}>{children}</h5>;
      return <h6 key={key}>{children}</h6>;
    }
    case 'code':
      return <CodeBlock key={key} code={normalizeText(token.text)} lang={token.lang} highlightQuery={highlightQuery} activeHighlight={activeHighlight} />;
    case 'blockquote':
      return <blockquote key={key}>{renderBlockTokens(token.tokens ?? [], key, highlightQuery, activeHighlight)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const ListTag = token.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={key} className="chat-md-list">
          {(token.items ?? []).map((item, index) => (
            <li key={`${key}-item-${index}`} className="chat-md-li">
              {item.task ? (
                <label className="chat-task-item">
                  <input type="checkbox" checked={Boolean(item.checked)} readOnly />
                  <span>{renderListItemContent(item, `${key}-task-${index}`, highlightQuery, activeHighlight)}</span>
                </label>
              ) : (
                renderListItemContent(item, `${key}-item-content-${index}`, highlightQuery, activeHighlight)
              )}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'table':
      return (
        <div key={key} className="chat-table-wrap">
          <table className="chat-md-table">
            <thead>
              <tr>
                {(token.header ?? []).map((cell, index) => (
                  <th key={`${key}-head-${index}`} align={token.align?.[index] ?? undefined}>
                    {renderTableCell(cell, `${key}-head-cell-${index}`, highlightQuery, activeHighlight)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(token.rows ?? []).map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`} align={token.align?.[cellIndex] ?? undefined}>
                      {renderTableCell(cell, `${key}-row-${rowIndex}-cell-content-${cellIndex}`, highlightQuery, activeHighlight)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderBlockTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
      }
      return <p key={key}>{splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight)}</p>;
  }
}

export function MarkdownContent({ text, className = 'chat-bubble-content', highlightQuery, activeHighlight, blockUnsafePaymentInstructions = false }: MarkdownContentProps) {
  const shouldBlock = blockUnsafePaymentInstructions && isLikelyUnsafePaymentInstruction(text);
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }) as MarkdownToken[], [text]);
  if (shouldBlock) {
    return <div className={className}><BlockedUnsafePaymentInstruction /></div>;
  }
  return <div className={className}>{renderBlockTokens(tokens, 'md', highlightQuery, activeHighlight)}</div>;
}
