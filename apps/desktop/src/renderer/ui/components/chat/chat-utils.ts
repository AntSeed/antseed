import { Marked, Renderer } from 'marked';
import bubbleStyles from './ChatBubble.module.scss';

/** CSS Module class names for imperative DOM use (e.g. streaming bubbles). */
export const chatBubbleClasses = {
  bubble: bubbleStyles.chatBubble,
  own: bubbleStyles.own,
  other: bubbleStyles.other,
  meta: bubbleStyles.chatBubbleMeta,
} as const;

type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
};

type ContentBlock = {
  type: string;
};

export function isToolResultOnlyMessage(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    (msg.content as ContentBlock[]).every((b) => b.type === 'tool_result')
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

let codeBlockIndex = 0;

const chatRenderer = new Renderer();
chatRenderer.code = ({ text, lang }) => {
  const langLabel = lang || 'code';
  const codeId = `chat-code-${codeBlockIndex++}`;
  return `<div class="chat-code-container"><div class="chat-code-header"><span class="code-lang">${escapeHtml(langLabel)}</span><button class="chat-code-copy-btn" type="button" data-copy-code="true" data-copy-target="${codeId}">Copy</button></div><pre><code id="${codeId}">${text}</code></pre></div>`;
};
chatRenderer.codespan = ({ text }) => `<code class="chat-inline-code">${text}</code>`;
chatRenderer.list = function (token) {
  const tag = token.ordered ? 'ol' : 'ul';
  let body = '';
  for (const item of token.items) {
    body += this.listitem(item);
  }
  return `<${tag} class="chat-md-list">${body}</${tag}>`;
};
chatRenderer.listitem = function ({ tokens }) {
  return `<li class="chat-md-li">${this.parser.parse(tokens)}</li>`;
};
chatRenderer.link = function ({ href, tokens }) {
  const rendered = this.parser.parseInline(tokens);
  if (!isSafeHref(href)) return `<span class="chat-inline-link-invalid">${rendered}</span>`;
  return `<a href="${escapeHtml(href)}" style="color:var(--accent-blue);text-decoration:underline" target="_blank" rel="noopener noreferrer">${rendered}</a>`;
};
chatRenderer.paragraph = function ({ tokens }) {
  return `<p>${this.parser.parseInline(tokens)}</p>`;
};

const marked = new Marked({
  renderer: chatRenderer,
  gfm: true,
  breaks: true,
});

export function renderMarkdown(text: string): string {
  codeBlockIndex = 0;
  return marked.parse(text) as string;
}
