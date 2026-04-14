import { useState, useCallback, useMemo, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ComputerTerminal01Icon,
  PlayIcon,
  Copy01Icon,
  Cancel01Icon,
  BookOpen01Icon,
  Loading03Icon,
} from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import type { ChatServiceOptionEntry } from '../../../core/state';
import styles from './ExternalClientsView.module.scss';

type ExternalClientsViewProps = {
  active: boolean;
};

type Tool = {
  name: string;
  tag: string;
  format: 'anthropic' | 'openai';
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
    description: 'Anthropic\'s official CLI agent. Runs in your terminal and uses the Anthropic API format.',
    envVar: 'ANTHROPIC_BASE_URL',
    getEndpoint: (port) => `http://localhost:${port}`,
    steps: [
      { label: 'Install Claude Code', command: 'npm install -g @anthropic-ai/claude-code' },
      { label: 'Set the proxy endpoint', command: 'export ANTHROPIC_BASE_URL=http://localhost:{port}' },
      { label: 'Run — requests route through AntSeed', command: 'claude' },
    ],
    persist: 'echo \'export ANTHROPIC_BASE_URL=http://localhost:{port}\' >> ~/.zshrc',
  },
  {
    name: 'OpenCode',
    tag: 'opencode',
    format: 'anthropic',
    description: 'Open-source AI coding agent. Uses the same Anthropic API format as Claude Code.',
    envVar: 'ANTHROPIC_BASE_URL',
    getEndpoint: (port) => `http://localhost:${port}`,
    steps: [
      { label: 'Install OpenCode', command: 'npm install -g opencode-ai' },
      { label: 'Set the proxy endpoint', command: 'export ANTHROPIC_BASE_URL=http://localhost:{port}' },
      { label: 'Run in your project directory', command: 'opencode' },
    ],
    persist: 'echo \'export ANTHROPIC_BASE_URL=http://localhost:{port}\' >> ~/.zshrc',
  },
  {
    name: 'Codex',
    tag: 'codex',
    format: 'openai',
    description: 'OpenAI\'s CLI coding agent. Reads OPENAI_BASE_URL for a custom endpoint.',
    envVar: 'OPENAI_BASE_URL',
    getEndpoint: (port) => `http://localhost:${port}/v1`,
    steps: [
      { label: 'Install Codex', command: 'npm install -g @openai/codex' },
      { label: 'Set the proxy endpoint', command: 'export OPENAI_BASE_URL=http://localhost:{port}/v1' },
      { label: 'Also set a dummy API key if required', command: 'export OPENAI_API_KEY=antseed' },
      { label: 'Run', command: 'codex' },
    ],
    persist: 'echo \'export OPENAI_BASE_URL=http://localhost:{port}/v1\' >> ~/.zshrc',
  },
  {
    name: 'OpenAI-compatible',
    tag: 'generic',
    format: 'openai',
    description: 'Cursor, Continue.dev, Aider, or any tool that accepts a custom OpenAI base URL.',
    envVar: 'Base URL',
    getEndpoint: (port) => `http://localhost:${port}/v1`,
    steps: [
      { label: 'Find the "Custom base URL" or "OpenAI API base" setting in your tool' },
      { label: 'Set it to the proxy endpoint below' },
      { label: 'Set any API key field to a placeholder value (e.g. antseed)', command: 'antseed' },
      { label: 'Select a service — requests are routed by AntSeed automatically' },
    ],
    persist: '',
  },
];

const DOCS_URL = 'https://antseed.com/docs/guides/using-the-api';

function normalizeServiceName(name: string): string {
  return name.replace(/[-_]+/g, ' ');
}

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
      messages: [{ role: 'user', content: 'Say hi in 5 words.' }],
    };
  } else if (protocol === 'openai-responses') {
    path = '/v1/responses';
    body = {
      model: serviceId || 'auto',
      input: 'Say hi in 5 words.',
    };
  } else {
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: serviceId || 'auto',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Say hi in 5 words.' }],
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

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button className={`${styles.secondaryBtn}${copied ? ` ${styles.copied}` : ''}`} onClick={handleCopy}>
      <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.5} />
      <span>{copied ? 'Copied' : (label ?? 'Copy')}</span>
    </button>
  );
}

function ToolModal({ tool, port, isOnline, onClose }: { tool: Tool; port: number; isOnline: boolean; onClose: () => void }) {
  const displayPort = isOnline ? port : 8377;
  const endpoint = tool.getEndpoint(displayPort);
  const exportLine = `export ${tool.envVar}=${endpoint}`;
  const persistLine = tool.persist.replace(/{port}/g, String(displayPort));

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
            <div className={styles.toolIcon}>
              <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} strokeWidth={1.5} />
            </div>
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

        <div className={styles.endpointRow}>
          <span className={styles.endpointLabel}>{tool.envVar}</span>
          <span className={styles.endpointValue}>{endpoint}</span>
          <CopyButton value={endpoint} />
        </div>

        <div className={styles.stepsSection}>
          <p className={styles.stepsLabel}>Setup</p>
          <ol className={styles.stepsList}>
            {tool.steps.map((step, i) => (
              <li key={i} className={styles.step}>
                <span className={styles.stepText}>{step.label}</span>
                {step.command && (
                  <div className={styles.stepCommand}>
                    <code className={styles.stepCode}>
                      {step.command.replace(/{port}/g, String(displayPort))}
                    </code>
                    <CopyButton value={step.command.replace(/{port}/g, String(displayPort))} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>

        {persistLine && (
          <div className={styles.persistRow}>
            <span className={styles.persistLabel}>Persist to shell</span>
            <div className={styles.persistCommand}>
              <code className={styles.stepCode}>{persistLine}</code>
              <CopyButton value={persistLine} />
            </div>
          </div>
        )}

        <div className={styles.exportRow}>
          <code className={styles.exportCode}>{exportLine}</code>
          <CopyButton value={exportLine} label="Copy export" />
        </div>
      </div>
    </div>
  );
}

type TryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'result'; status: number; body: string }
  | { kind: 'error'; error: string };

export function ExternalClientsView({ active }: ExternalClientsViewProps) {
  const {
    chatProxyStatus,
    chatProxyPort,
    chatServiceOptions,
    chatSelectedServiceValue,
  } = useUiSnapshot();
  const isOnline = chatProxyStatus.tone === 'active' && chatProxyPort > 0;
  const displayPort = isOnline ? chatProxyPort : 8377;

  const freeOptions = useMemo<ChatServiceOptionEntry[]>(
    () =>
      chatServiceOptions.filter(
        (o) => o.inputUsdPerMillion === 0 && o.outputUsdPerMillion === 0,
      ),
    [chatServiceOptions],
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
    try {
      const res = await bridge.apiTryProxyRequest({
        port: displayPort,
        path: request.path,
        method: request.method,
        headers: request.headers,
        body: request.bodyText,
      });
      if (!res.ok) {
        setTryState({ kind: 'error', error: res.error || 'Request failed' });
      } else {
        setTryState({ kind: 'result', status: res.status, body: res.body });
      }
    } catch (e) {
      setTryState({ kind: 'error', error: (e as Error)?.message ?? String(e) });
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
      <div className="page-header">
        <h2>API</h2>
        <div className={`${styles.proxyBadge} ${isOnline ? styles.proxyOnline : styles.proxyOffline}`}>
          <span className={styles.proxyBadgeDot} />
          {isOnline ? `Proxy active · :${chatProxyPort}` : 'Proxy offline'}
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.twoCol}>
        <div className={styles.leftCol}>
          <div className={styles.intro}>
            <h3 className={styles.sectionTitle}>Your local API proxy</h3>
            <p className={styles.introText}>
              AntSeed runs a local HTTP proxy at{' '}
              <code className={styles.inlineCode}>http://localhost:{displayPort}</code> that routes your
              requests to peers on the network. Any tool that accepts a custom base URL can point at it —
              no API keys needed.
            </p>
          </div>

          <ul className={styles.bulletList}>
            <li>
              <span className={styles.bulletTitle}>AntStation runs it for you</span>
              <span className={styles.bulletText}>
                While AntStation is open, the proxy stays online in the background. Quit AntStation and it
                shuts down.
              </span>
            </li>
            <li>
              <span className={styles.bulletTitle}>Or run it yourself</span>
              <span className={styles.bulletText}>
                Prefer headless or server use? Install the CLI and run{' '}
                <code className={styles.inlineCode}>antseed buyer start</code> — the proxy listens on
                the same port.
              </span>
            </li>
            <li>
              <span className={styles.bulletTitle}>Pin a service or let AntSeed route</span>
              <span className={styles.bulletText}>
                Send <code className={styles.inlineCode}>x-antseed-pin-peer</code> to lock onto a peer, or
                omit it and let the proxy pick the best match by price and reputation.
              </span>
            </li>
            <li>
              <span className={styles.bulletTitle}>For developers going deeper</span>
              <span className={styles.bulletText}>
                This page is a quick jumping-off point. Full protocol reference, headers, and streaming
                semantics live in the docs.
              </span>
            </li>
          </ul>

          <div className={styles.docsRow}>
            <button className={styles.linkBtn} onClick={openDocs}>
              <HugeiconsIcon icon={BookOpen01Icon} size={13} strokeWidth={1.5} />
              Read the API docs
            </button>
          </div>
        </div>

        <div className={styles.tryBlock}>
          <div className={styles.tryHeader}>
            <span className={styles.sectionLabel}>Try a free service</span>
            {freeOptions.length > 0 ? (
              <select
                className={styles.freeSelect}
                value={tryServiceValue}
                onChange={(e) => handleSelectFreeService(e.target.value)}
              >
                {freeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {(o.peerLabel || 'peer')} · {normalizeServiceName(o.label)}
                  </option>
                ))}
              </select>
            ) : (
              <span className={styles.targetEmpty}>No free services discovered yet</span>
            )}
          </div>

          <div className={styles.curlBlock}>
            <pre className={styles.curlCode}>
              <code>{curl}</code>
            </pre>
          </div>

          <div className={styles.tryActions}>
            <CopyButton value={curl} label="Copy curl" />
            <button
              className={styles.primaryBtn}
              onClick={handleTry}
              disabled={!canTry || tryState.kind === 'loading'}
            >
              {tryState.kind === 'loading' ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} size={13} strokeWidth={1.5} />
                  <span>Running…</span>
                </>
              ) : (
                <>
                  <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.5} />
                  <span>Try it</span>
                </>
              )}
            </button>
            {!isOnline && <span className={styles.tryHint}>Proxy is offline — start the buyer runtime from Network.</span>}
          </div>

          <div className={styles.responsePanel}>
            {tryState.kind === 'idle' && (
              <div className={styles.responsePlaceholder}>Response will appear here.</div>
            )}
            {tryState.kind === 'loading' && (
              <div className={styles.responsePlaceholder}>Waiting for peer…</div>
            )}
            {tryState.kind === 'error' && (
              <pre className={`${styles.responseBody} ${styles.responseError}`}>
                <code>{tryState.error}</code>
              </pre>
            )}
            {tryState.kind === 'result' && (
              <pre
                className={`${styles.responseBody} ${tryState.status >= 400 ? styles.responseError : ''}`}
              >
                <code>
                  HTTP {tryState.status}
                  {'\n\n'}
                  {formatResponse(tryState.status, tryState.body)}
                </code>
              </pre>
            )}
          </div>
        </div>
        </div>

        <div className={styles.clientsSection}>
          <span className={styles.sectionLabel}>Integrate with external clients</span>
          <div className={styles.clientsRow}>
            {TOOLS.map((tool) => (
              <button key={tool.tag} className={styles.clientTile} onClick={() => setOpenTool(tool)}>
                <div className={styles.clientIcon}>
                  <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} strokeWidth={1.5} />
                </div>
                <span className={styles.clientName}>{tool.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {openTool && <ToolModal tool={openTool} port={chatProxyPort} isOnline={isOnline} onClose={() => setOpenTool(null)} />}
    </section>
  );
}
