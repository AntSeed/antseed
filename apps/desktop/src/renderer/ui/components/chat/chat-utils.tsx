import React, { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Lexer } from 'marked';
import type { ChatMessage } from './chat-shared';
import { isToolResultOnlyMessage as isToolResultOnlyMessageShared } from './chat-shared';

type MarkdownContentProps = {
  text: string;
  className?: string;
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

function isSafeHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed, 'https://antseed.invalid');
    const protocol = parsed.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
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

function renderInlineTokens(tokens: MarkdownToken[] | undefined, keyPrefix: string): ReactNode[] {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  return tokens.map((token, index) => renderInlineToken(token, `${keyPrefix}-${index}`));
}

function renderInlineToken(token: MarkdownToken, key: string): ReactNode {
  switch (token.type) {
    case 'text':
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderInlineTokens(token.tokens, key)}</Fragment>;
      }
      return <Fragment key={key}>{normalizeText(token.text)}</Fragment>;
    case 'escape':
      return <Fragment key={key}>{normalizeText(token.text)}</Fragment>;
    case 'strong':
      return <strong key={key}>{renderInlineTokens(token.tokens, key)}</strong>;
    case 'em':
      return <em key={key}>{renderInlineTokens(token.tokens, key)}</em>;
    case 'codespan':
      return (
        <code key={key} className="chat-inline-code">
          {normalizeText(token.text)}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'del':
      return <del key={key}>{renderInlineTokens(token.tokens, key)}</del>;
    case 'link': {
      const href = normalizeText(token.href);
      const content = renderInlineTokens(token.tokens, key);
      if (!isSafeHref(href)) {
        return (
          <span key={key} className="chat-inline-link-invalid">
            {content}
          </span>
        );
      }
      return (
        <a
          key={key}
          href={href}
          style={{ color: 'var(--accent-blue)', textDecoration: 'underline' }}
          target="_blank"
          rel="noopener noreferrer"
          title={token.title ?? undefined}
        >
          {content}
        </a>
      );
    }
    case 'image': {
      const href = normalizeText(token.href);
      const alt = flattenPlainText(token.tokens) || normalizeText(token.text) || 'Image';
      if (!isSafeHref(href)) {
        return (
          <span key={key} className="chat-inline-link-invalid">
            {alt}
          </span>
        );
      }
      return <img key={key} src={href} alt={alt} className="chat-inline-image" />;
    }
    default:
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderInlineTokens(token.tokens, key)}</Fragment>;
      }
      return <Fragment key={key}>{normalizeText(token.text ?? token.raw)}</Fragment>;
  }
}

function renderBlockTokens(tokens: MarkdownToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => renderBlockToken(token, `${keyPrefix}-${index}`));
}

function renderTableCell(token: MarkdownToken, key: string): ReactNode {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    return <Fragment key={key}>{renderInlineTokens(token.tokens, key)}</Fragment>;
  }
  return <Fragment key={key}>{normalizeText(token.text ?? token.raw)}</Fragment>;
}

function renderListItemContent(token: MarkdownToken, key: string): ReactNode {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    const hasBlockTokens = token.tokens.some((child) =>
      ['paragraph', 'space', 'text', 'strong', 'em', 'codespan', 'link', 'del', 'br'].includes(child.type) === false);
    if (hasBlockTokens) {
      return <>{renderBlockTokens(token.tokens, key)}</>;
    }
    return <>{renderInlineTokens(token.tokens, key)}</>;
  }
  return normalizeText(token.text ?? token.raw);
}

export function isHtmlContent(code: string, lang?: string): boolean {
  const l = normalizeText(lang).trim().toLowerCase();
  if (l === 'html' || l === 'htm') return true;
  if (!l || l === 'code') {
    return /^\s*<!doctype\s+html/i.test(code) || /^\s*<html[\s>]/i.test(code);
  }
  return false;
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="chat-code-copy-btn" type="button" onClick={handleCopy}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const langLabel = normalizeText(lang).trim() || 'code';

  return (
    <div className="chat-code-container">
      <div className="chat-code-header">
        <span className="code-lang">{langLabel}</span>
        <CopyButton code={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderBlockToken(token: MarkdownToken, key: string): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'paragraph':
      return <p key={key}>{renderInlineTokens(token.tokens, key)}</p>;
    case 'text':
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <p key={key}>{renderInlineTokens(token.tokens, key)}</p>;
      }
      return <p key={key}>{normalizeText(token.text)}</p>;
    case 'heading': {
      const depth = Math.min(Math.max(Number(token.depth) || 1, 1), 6);
      const children = renderInlineTokens(token.tokens, key);
      if (depth === 1) return <h1 key={key}>{children}</h1>;
      if (depth === 2) return <h2 key={key}>{children}</h2>;
      if (depth === 3) return <h3 key={key}>{children}</h3>;
      if (depth === 4) return <h4 key={key}>{children}</h4>;
      if (depth === 5) return <h5 key={key}>{children}</h5>;
      return <h6 key={key}>{children}</h6>;
    }
    case 'code':
      return <CodeBlock key={key} code={normalizeText(token.text)} lang={token.lang} />;
    case 'blockquote':
      return <blockquote key={key}>{renderBlockTokens(token.tokens ?? [], key)}</blockquote>;
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
                  <span>{renderListItemContent(item, `${key}-task-${index}`)}</span>
                </label>
              ) : (
                renderListItemContent(item, `${key}-item-content-${index}`)
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
                    {renderTableCell(cell, `${key}-head-cell-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(token.rows ?? []).map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`} align={token.align?.[cellIndex] ?? undefined}>
                      {renderTableCell(cell, `${key}-row-${rowIndex}-cell-content-${cellIndex}`)}
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
        return <Fragment key={key}>{renderBlockTokens(token.tokens, key)}</Fragment>;
      }
      return <p key={key}>{normalizeText(token.text ?? token.raw)}</p>;
  }
}

export function MarkdownContent({ text, className = 'chat-bubble-content' }: MarkdownContentProps) {
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }) as MarkdownToken[], [text]);
  return <div className={className}>{renderBlockTokens(tokens, 'md')}</div>;
}
