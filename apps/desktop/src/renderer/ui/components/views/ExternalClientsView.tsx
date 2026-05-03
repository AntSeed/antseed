import { useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  PlayIcon,
  Copy01Icon,
  Cancel01Icon,
  BookOpen01Icon,
  Loading03Icon,
  ArrowRight01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import type { ChatServiceOptionEntry } from '../../../core/state';
import { ServiceDropdown } from '../chat/ServiceDropdown';
import anthropicLogo from '../../../assets/provider-logos/anthropic.png';
import openaiLogo from '../../../assets/provider-logos/openai.png';
import styles from './ExternalClientsView.module.scss';

type ExternalClientsViewProps = {
  active: boolean;
};

const PROVIDER_LOGO: Record<'anthropic' | 'openai', { src: string; alt: string }> = {
  anthropic: { src: anthropicLogo, alt: 'Anthropic' },
  openai: { src: openaiLogo, alt: 'OpenAI' },
};

type Tool = {
  name: string;
  tag: string;
  format: 'anthropic' | 'openai';
  tagline: string;
  description: string;
  envVar: string;
  getEndpoint: (port: number) => string;
  steps: { label: string; command?: string }[];
  persist: string;
};

const TOOLS: Tool[] = [
  {
    name: 'Claude Code',
    tag: 'claude',
    format: 'anthropic',
    tagline: 'Anthropic’s official CLI',
    description: 'Anthropic\'s official CLI agent. Runs in your terminal and uses the Anthropic API format.',
    envVar: 'ANTHROPIC_BASE_URL',
    getEndpoint: (port) => `http://localhost:${port}`,
    steps: [
      { label: 'Install Claude Code', command: 'npm install -g @anthropic-ai/claude-code' },
      { label: 'Set the proxy endpoint', command: 'export ANTHROPIC_BASE_URL=http://localhost:{port}' },
      { label: 'Run — requests route through AntSeed', command: 'claude --model <service-id>' },
    ],
    persist: 'echo \'export ANTHROPIC_BASE_URL=http://localhost:{port}\' >> ~/.zshrc',
  },
  {
    name: 'OpenCode',
    tag: 'opencode',
    format: 'anthropic',
    tagline: 'Open-source coding agent',
    description: 'Open-source AI coding agent. Uses the same Anthropic API format as Claude Code.',
    envVar: 'ANTHROPIC_BASE_URL',
    getEndpoint: (port) => `http://localhost:${port}`,
    steps: [
      { label: 'Install OpenCode', command: 'npm install -g opencode-ai' },
      { label: 'Set the proxy endpoint', command: 'export ANTHROPIC_BASE_URL=http://localhost:{port}' },
      { label: 'Run in your project directory', command: 'opencode' },
      { label: 'Or launch pinned to a specific model', command: 'opencode --model <service-id>' },
    ],
    persist: 'echo \'export ANTHROPIC_BASE_URL=http://localhost:{port}\' >> ~/.zshrc',
  },
  {
    name: 'Codex',
    tag: 'codex',
    format: 'openai',
    tagline: 'OpenAI’s CLI agent',
    description: 'OpenAI\'s CLI coding agent. Reads OPENAI_BASE_URL for a custom endpoint.',
    envVar: 'OPENAI_BASE_URL',
    getEndpoint: (port) => `http://localhost:${port}/v1`,
    steps: [
      { label: 'Install Codex', command: 'npm install -g @openai/codex' },
      { label: 'Set the proxy endpoint', command: 'export OPENAI_BASE_URL=http://localhost:{port}/v1' },
      { label: 'Also set a dummy API key if required', command: 'export OPENAI_API_KEY=antseed' },
      { label: 'Launch pinned to a specific model', command: 'codex --model <service-id>' },
    ],
    persist: 'echo \'export OPENAI_BASE_URL=http://localhost:{port}/v1\' >> ~/.zshrc',
  },
  {
    name: 'OpenAI-compatible',
    tag: 'generic',
    format: 'openai',
    tagline: 'Cursor, Continue, Aider, …',
    description: 'Cursor, Continue.dev, Aider, or any tool that accepts a custom OpenAI base URL.',
    envVar: 'Base URL',
    getEndpoint: (port) => `http://localhost:${port}/v1`,
    steps: [
      { label: 'Find the "Custom base URL" or "OpenAI API base" setting in your tool' },
      { label: 'Set it to the proxy endpoint below', command: 'http://localhost:{port}/v1/chat/completions' },
      { label: 'Set any API key field to a placeholder value (e.g. antseed)' },
      { label: 'Select a service — requests are routed by AntSeed automatically' },
    ],
    persist: '',
  },
];

const DOCS_URL = 'https://antseed.com/docs/guides/using-the-api';

const STEPS = [
  {
    title: 'AntStation runs it for you',
    text: 'While AntStation is open, the proxy stays online in the background. Quit AntStation and it shuts down.',
  },
  {
    title: 'Or run it yourself',
    text: 'Prefer headless or server use? Install the CLI and run',
    code: 'antseed buyer start',
    textAfter: '— the proxy listens on the same port.',
  },
  {
    title: 'Pin a service or let AntSeed route',
    text: 'Send',
    code: 'x-antseed-pin-peer',
    textAfter: 'to lock onto a peer, or omit it and let the proxy pick the best match by price and reputation.',
  },
  {
    title: 'For developers going deeper',
    text: 'This page is a quick jumping-off point. Full protocol reference, headers, and streaming semantics live in the docs.',
  },
];

type BuiltRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string;
};

function buildRequest(option: ChatServiceOptionEntry | undefined, port: number): BuiltRequest {
  const provider = option?.provider || 'anthropic';
  const protocol = option?.protocol || 'anthropic-messages';
  const peerId = option?.peerId || '';
  const serviceId = option?.id || '';

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (provider) headers['x-antseed-provider'] = provider;
  if (peerId) headers['x-antseed-pin-peer'] = peerId;

  let path = '/v1/messages';
  let body: Record<string, unknown> = {};

  if (protocol === 'openai-chat-completions') {
    path = '/v1/chat/completions';
    body = {
      model: serviceId || 'auto',
      messages: [{ role: 'user', content: 'Hello.' }],
    };
  } else if (protocol === 'openai-responses') {
    path = '/v1/responses';
    body = {
      model: serviceId || 'auto',
      input: 'Hello.',
    };
  } else {
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: serviceId || 'auto',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hello.' }],
    };
  }

  return {
    path,
    method: 'POST',
    headers,
    bodyText: JSON.stringify(body, null, 2),
  };
}

function formatCurl(port: number, req: BuiltRequest): string {
  const headerLines = Object.entries(req.headers)
    .map(([k, v]) => `  -H '${k}: ${v}'`)
    .join(' \\\n');
  const singleLineBody = JSON.stringify(JSON.parse(req.bodyText));
  return `curl -N http://localhost:${port}${req.path} \\\n${headerLines} \\\n  -d '${singleLineBody}'`;
}

function formatResponse(status: number, body: string): string {
  if (!body) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 2 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Timeout',
  409: 'Conflict',
  422: 'Unprocessable',
  429: 'Rate Limited',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Unavailable',
  504: 'Gateway Timeout',
};

function statusText(code: number): string {
  return STATUS_TEXT[code] ?? (code >= 500 ? 'Server Error' : code >= 400 ? 'Client Error' : code >= 300 ? 'Redirect' : 'OK');
}

const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

function highlightJsonLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  JSON_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSON_TOKEN_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1] !== undefined) {
      if (m[2]) {
        out.push(<span key={key++} className={styles.jsonKey}>{m[1]}</span>);
        out.push(<span key={key++} className={styles.jsonPunct}>{m[2]}</span>);
      } else {
        out.push(<span key={key++} className={styles.jsonString}>{m[1]}</span>);
      }
    } else if (m[3] !== undefined) {
      const cls = m[3] === 'null' ? styles.jsonNull : styles.jsonBool;
      out.push(<span key={key++} className={cls}>{m[3]}</span>);
    } else if (m[4] !== undefined) {
      out.push(<span key={key++} className={styles.jsonNumber}>{m[4]}</span>);
    } else if (m[5] !== undefined) {
      out.push(<span key={key++} className={styles.jsonPunct}>{m[5]}</span>);
    }
    last = JSON_TOKEN_RE.lastIndex;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function HighlightedJson({ src }: { src: string }) {
  const lines = useMemo(() => src.split('\n'), [src]);
  const gutterWidth = String(lines.length).length;
  return (
    <div className={styles.jsonView}>
      <div
        className={styles.jsonGutter}
        aria-hidden="true"
        style={{ width: `${gutterWidth + 1}ch` }}
      >
        {lines.map((_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <pre className={styles.jsonCode}>
        <code>
          {lines.map((line, i) => (
            <span key={i} className={styles.jsonLine}>
              {highlightJsonLine(line)}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function tryParseModel(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { model?: unknown }).model === 'string') {
      return (parsed as { model: string }).model;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function CopyChip({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button className={`${styles.chipBtn}${copied ? ` ${styles.copied}` : ''}`} onClick={handleCopy}>
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={12} strokeWidth={1.8} />
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

function EndpointCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button
      type="button"
      className={`${styles.endpointCopy}${copied ? ` ${styles.copied}` : ''}`}
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy endpoint'}
      title={copied ? 'Copied' : 'Copy endpoint'}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.6} />
    </button>
  );
}

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <div className={styles.codeBlock}>
      <code className={styles.codeBlockText}>{value}</code>
      <button
        className={`${styles.codeBlockCopy}${copied ? ` ${styles.copied}` : ''}`}
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function buildToolScript(tool: Tool, displayPort: number): string {
  const lines: string[] = [];
  for (const step of tool.steps) {
    lines.push(`# ${step.label}`);
    if (step.command) {
      lines.push(step.command.replace(/{port}/g, String(displayPort)));
    }
    lines.push('');
  }
  const persistLine = tool.persist.replace(/{port}/g, String(displayPort));
  if (persistLine) {
    lines.push('# Persist to your shell');
    lines.push(persistLine);
  }
  return lines.join('\n').replace(/\n+$/, '');
}

function ToolModal({ tool, port, isOnline, onClose }: { tool: Tool; port: number; isOnline: boolean; onClose: () => void }) {
  const displayPort = isOnline ? port : 8377;
  const script = buildToolScript(tool, displayPort);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.toolHeader}>
            <div className={styles.toolMeta}>
              <span className={styles.toolName}>{tool.name}</span>
              <span
                className={`${styles.toolFormat} ${tool.format === 'anthropic' ? styles.formatAnthropic : styles.formatOpenai}`}
              >
                {tool.format === 'anthropic' ? 'Anthropic format' : 'OpenAI format'}
              </span>
            </div>
          </div>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.5} />
          </button>
        </div>

        <p className={styles.toolDesc}>{tool.description}</p>

        <CodeBlock value={script} />
      </div>
    </div>
  );
}

type TryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'result'; status: number; body: string; latencyMs: number; sizeBytes: number; arrivedAt: number }
  | { kind: 'error'; error: string; latencyMs?: number };

export function ExternalClientsView({ active }: ExternalClientsViewProps) {
  const {
    chatProxyStatus,
    chatProxyPort,
    chatServiceOptions,
    chatSelectedServiceValue,
    discoverRows,
  } = useUiSnapshot();
  const isOnline = chatProxyStatus.tone === 'active' && chatProxyPort > 0;
  const displayPort = isOnline ? chatProxyPort : 8377;

  const peerChannelCounts = useMemo<Map<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const row of discoverRows) {
      const prev = counts.get(row.peerId) ?? 0;
      const candidate = row.onChainActiveChannelCount ?? row.onChainChannelCount ?? 0;
      if (candidate > prev) counts.set(row.peerId, candidate);
    }
    return counts;
  }, [discoverRows]);

  const freeOptions = useMemo<ChatServiceOptionEntry[]>(
    () => {
      const filtered = chatServiceOptions.filter(
        (o) => o.inputUsdPerMillion === 0 && o.outputUsdPerMillion === 0,
      );
      return [...filtered].sort((a, b) => {
        const ca = peerChannelCounts.get(a.peerId) ?? 0;
        const cb = peerChannelCounts.get(b.peerId) ?? 0;
        if (cb !== ca) return cb - ca;
        return (a.peerLabel || '').localeCompare(b.peerLabel || '');
      });
    },
    [chatServiceOptions, peerChannelCounts],
  );

  const [tryServiceValue, setTryServiceValue] = useState<string>('');

  useEffect(() => {
    if (freeOptions.length === 0) {
      if (tryServiceValue) setTryServiceValue('');
      return;
    }
    if (freeOptions.some((o) => o.value === tryServiceValue)) return;
    const preferred = freeOptions.find((o) => o.value === chatSelectedServiceValue);
    setTryServiceValue((preferred ?? freeOptions[0]).value);
  }, [freeOptions, chatSelectedServiceValue, tryServiceValue]);

  const targetOption = useMemo<ChatServiceOptionEntry | undefined>(
    () => freeOptions.find((o) => o.value === tryServiceValue),
    [freeOptions, tryServiceValue],
  );
  const request = useMemo(() => buildRequest(targetOption, displayPort), [targetOption, displayPort]);
  const curl = useMemo(() => formatCurl(displayPort, request), [displayPort, request]);

  const [tryState, setTryState] = useState<TryState>({ kind: 'idle' });
  const [openTool, setOpenTool] = useState<Tool | null>(null);

  const canTry = Boolean(targetOption) && isOnline && !!window.antseedDesktop?.apiTryProxyRequest;

  const handleTry = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.apiTryProxyRequest) return;
    setTryState({ kind: 'loading' });
    const startedAt = performance.now();
    try {
      const res = await bridge.apiTryProxyRequest({
        port: displayPort,
        path: request.path,
        method: request.method,
        headers: request.headers,
        body: request.bodyText,
      });
      const latencyMs = performance.now() - startedAt;
      if (!res.ok) {
        setTryState({ kind: 'error', error: res.error || 'Request failed', latencyMs });
      } else {
        const sizeBytes = new TextEncoder().encode(res.body || '').length;
        setTryState({
          kind: 'result',
          status: res.status,
          body: res.body,
          latencyMs,
          sizeBytes,
          arrivedAt: Date.now(),
        });
      }
    } catch (e) {
      const latencyMs = performance.now() - startedAt;
      setTryState({ kind: 'error', error: (e as Error)?.message ?? String(e), latencyMs });
    }
  }, [displayPort, request]);

  const openDocs = useCallback(() => {
    window.open(DOCS_URL, '_blank');
  }, []);

  const handleSelectFreeService = useCallback((value: string) => {
    setTryServiceValue(value);
    setTryState({ kind: 'idle' });
  }, []);

  return (
    <section className={`view view-api ${styles.view}${active ? ' active' : ''}`} role="tabpanel">
      <div className={`page-header ${styles.pageHeader}`}>
        <div className={styles.pageHeadingGroup}>
          <span className={styles.eyebrow}>Developer</span>
          <h2>API</h2>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.twoCol}>
          {/* ── LEFT: Documentation ── */}
          <div className={styles.leftCol}>
            <div className={styles.heroBlock}>
              <span className={styles.eyebrow}>Local endpoint</span>
              <div className={styles.endpointHead}>
                <div className={styles.endpointRow}>
                  <span className={styles.endpointMethod}>HTTP</span>
                  <code className={styles.endpointUrl}>http://localhost:{displayPort}</code>
                  <EndpointCopyButton value={`http://localhost:${displayPort}`} />
                </div>
                <button className={styles.docsCta} onClick={openDocs}>
                  <HugeiconsIcon icon={BookOpen01Icon} size={14} strokeWidth={1.6} />
                  <span>Read the API docs</span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.6} className={styles.docsCtaArrow} />
                </button>
              </div>
              <p className={styles.heroDesc}>
                AntSeed runs a local HTTP proxy that routes your requests to peers on the network.
                Any tool that accepts a custom base URL can point at it — no API keys needed.
              </p>
            </div>

            <ol className={styles.steps}>
              {STEPS.map((step, i) => (
                <li key={i} className={styles.step}>
                  <span className={styles.stepNum}>{String(i + 1).padStart(2, '0')}</span>
                  <div className={styles.stepBody}>
                    <span className={styles.stepTitle}>{step.title}</span>
                    <span className={styles.stepText}>
                      {step.text}
                      {step.code && (
                        <>
                          {' '}<code className={styles.inlineCode}>{step.code}</code>
                          {step.textAfter ? ` ${step.textAfter}` : ''}
                        </>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ol>

            <div className={styles.clientLinks}>
              <span className={styles.sectionLabel}>External clients</span>
              <div className={styles.clientGrid}>
                {TOOLS.map((tool) => {
                  const logo = PROVIDER_LOGO[tool.format];
                  return (
                    <button
                      key={tool.tag}
                      className={styles.clientCard}
                      onClick={() => setOpenTool(tool)}
                    >
                      <span className={styles.clientCardLogo}>
                        <img
                          src={logo.src}
                          alt={logo.alt}
                          className={styles.clientCardLogoImg}
                          draggable={false}
                        />
                      </span>
                      <span className={styles.clientCardBody}>
                        <span className={styles.clientCardName}>{tool.name}</span>
                        <span className={styles.clientCardTagline}>{tool.tagline}</span>
                      </span>
                      <span className={styles.clientCardFormat}>
                        {tool.format === 'anthropic' ? 'anthropic' : 'openai'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── RIGHT: Playground ── */}
          <div className={styles.tryBlock}>
            <div className={styles.tryHeader}>
              <div className={styles.tryHeaderTitle}>
                <span className={styles.eyebrow}>Playground</span>
                <span className={styles.tryHeaderHeading}>Try a free service</span>
              </div>
              {freeOptions.length > 0 ? (
                <ServiceDropdown
                  options={freeOptions}
                  value={tryServiceValue}
                  disabled={false}
                  onChange={handleSelectFreeService}
                  align="end"
                  placeholder="Select a service"
                />
              ) : (
                <span className={styles.targetEmpty}>No free services discovered yet</span>
              )}
            </div>

            <div className={styles.codeWindow}>
              <div className={styles.codeWindowHead}>
                <span className={styles.codeWindowMethod}>{request.method}</span>
                <span className={styles.codeWindowPath}>{request.path}</span>
                <span className={styles.codeWindowSpacer} />
                <span className={styles.codeWindowFormat}>curl</span>
                <CopyChip value={curl} label="Copy" />
              </div>
              <pre className={styles.curlCode}>
                <code>{curl}</code>
              </pre>
            </div>

            <div className={styles.tryActions}>
              <button
                className={styles.primaryBtn}
                onClick={handleTry}
                disabled={!canTry || tryState.kind === 'loading'}
              >
                {tryState.kind === 'loading' ? (
                  <>
                    <HugeiconsIcon icon={Loading03Icon} size={13} strokeWidth={1.8} className={styles.spinIcon} />
                    <span>Running…</span>
                  </>
                ) : (
                  <>
                    <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.8} />
                    <span>Try it</span>
                  </>
                )}
              </button>
              {!isOnline && <span className={styles.tryHint}>Proxy is offline — start the buyer runtime from Network.</span>}
              <div className={`${styles.proxyBadge} ${isOnline ? styles.proxyOnline : styles.proxyOffline}`}>
                <span className={styles.proxyBadgeDot} />
                <span className={styles.proxyBadgeText}>
                  {isOnline ? 'Proxy active' : 'Proxy offline'}
                </span>
                {isOnline && (
                  <>
                    <span className={styles.proxyBadgeSep} />
                    <span className={styles.proxyBadgePort}>:{chatProxyPort}</span>
                  </>
                )}
              </div>
            </div>

            <div
              className={`${styles.responseWindow} ${
                tryState.kind === 'result'
                  ? tryState.status >= 400
                    ? styles.respError
                    : styles.respOk
                  : tryState.kind === 'error'
                    ? styles.respError
                    : tryState.kind === 'loading'
                      ? styles.respPending
                      : styles.respIdle
              }`}
              key={tryState.kind === 'result' ? tryState.arrivedAt : tryState.kind}
            >
              <div className={styles.responseWindowHead}>
                <div className={styles.responseHeadLeft}>
                  <span className={styles.respIndicator} aria-hidden="true" />
                  {tryState.kind === 'result' ? (
                    <>
                      <span className={styles.respStatusCode}>{tryState.status}</span>
                      <span className={styles.respStatusText}>{statusText(tryState.status)}</span>
                    </>
                  ) : tryState.kind === 'error' ? (
                    <>
                      <span className={styles.respStatusCode}>—</span>
                      <span className={styles.respStatusText}>error</span>
                    </>
                  ) : tryState.kind === 'loading' ? (
                    <>
                      <span className={styles.respStatusCode}>···</span>
                      <span className={styles.respStatusText}>routing</span>
                    </>
                  ) : (
                    <>
                      <span className={styles.respStatusCode}>—</span>
                      <span className={styles.respStatusText}>idle</span>
                    </>
                  )}
                  <span className={styles.respDot} aria-hidden="true">/</span>
                  <span className={styles.respEndpoint}>
                    <span className={styles.respMethod}>{request.method}</span>
                    <span className={styles.respPath}>{request.path}</span>
                  </span>
                </div>
                <div className={styles.responseHeadRight}>
                  {(tryState.kind === 'result' || (tryState.kind === 'error' && tryState.latencyMs !== undefined)) && (
                    <>
                      <span className={styles.respMetric}>
                        {formatLatency(tryState.kind === 'result' ? tryState.latencyMs : tryState.latencyMs!)}
                      </span>
                      {tryState.kind === 'result' && (
                        <>
                          <span className={styles.respMetricSep}>·</span>
                          <span className={styles.respMetric}>{formatBytes(tryState.sizeBytes)}</span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              {tryState.kind === 'result' && (
                <div className={styles.respMetaLine}>
                  {targetOption?.peerLabel && (
                    <>
                      <span className={styles.respMetaLabel}>via</span>
                      <span className={styles.respMetaValue}>{targetOption.peerLabel}</span>
                    </>
                  )}
                  {(() => {
                    const m = tryParseModel(tryState.body);
                    return m ? (
                      <>
                        {targetOption?.peerLabel && <span className={styles.respMetaSep}>·</span>}
                        <span className={styles.respMetaLabel}>model</span>
                        <span className={styles.respMetaValue}>{m}</span>
                      </>
                    ) : null;
                  })()}
                </div>
              )}
              <div className={styles.responseBodyWrap}>
                {tryState.kind === 'idle' && (
                  <div className={styles.responsePlaceholder}>
                    <div className={styles.placeholderGlyph} aria-hidden="true">
                      <span className={styles.placeholderRing} />
                      <span className={styles.placeholderCore} />
                    </div>
                    <span className={styles.placeholderTitle}>awaiting response</span>
                    <span className={styles.placeholderHint}>
                      send the request to inspect a live exchange
                    </span>
                  </div>
                )}
                {tryState.kind === 'loading' && (
                  <div className={styles.responsePlaceholder}>
                    <div className={styles.placeholderGlyph} aria-hidden="true">
                      <span className={`${styles.placeholderRing} ${styles.placeholderRingActive}`} />
                      <span className={`${styles.placeholderCore} ${styles.placeholderCoreActive}`} />
                    </div>
                    <span className={styles.placeholderTitle}>routing through the network</span>
                    <span className={styles.placeholderHint}>negotiating with peer…</span>
                  </div>
                )}
                {tryState.kind === 'error' && (
                  <pre className={`${styles.responseBody} ${styles.responseError}`}>
                    <code>{tryState.error}</code>
                  </pre>
                )}
                {tryState.kind === 'result' && (
                  <HighlightedJson src={formatResponse(tryState.status, tryState.body)} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {openTool && <ToolModal tool={openTool} port={chatProxyPort} isOnline={isOnline} onClose={() => setOpenTool(null)} />}
    </section>
  );
}
