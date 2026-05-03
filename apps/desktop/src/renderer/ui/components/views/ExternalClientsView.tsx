import { useState, useCallback, useMemo, useEffect, useRef, type CSSProperties, type SVGProps } from 'react';
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
import styles from './ExternalClientsView.module.scss';

type ExternalClientsViewProps = {
  active: boolean;
};

type LogoComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element;

const AnthropicMark: LogoComponent = (props) => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden focusable={false} {...props}>
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

const OpenAIMark: LogoComponent = (props) => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden focusable={false} {...props}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.4069-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

const OpenCodeMark: LogoComponent = (props) => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false} {...props}>
    <path d="M9 7 4 12l5 5" />
    <path d="m15 7 5 5-5 5" />
    <path d="m13.4 5.5-2.8 13" strokeOpacity="0.55" />
  </svg>
);

const GenericMark: LogoComponent = (props) => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden focusable={false} {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" strokeOpacity="0.55" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" strokeOpacity="0.55" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
  </svg>
);

type Tool = {
  name: string;
  tag: string;
  format: 'anthropic' | 'openai';
  tagline: string;
  Logo: LogoComponent;
  /** Hex brand color used to tint the logo glyph + tile. */
  brand: string;
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
    Logo: AnthropicMark,
    brand: '#cc785c',
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
    Logo: OpenCodeMark,
    brand: '#ea580c',
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
    Logo: OpenAIMark,
    brand: '#10a37f',
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
    Logo: GenericMark,
    brand: '#64748b',
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
  | { kind: 'result'; status: number; body: string }
  | { kind: 'error'; error: string };

type ServicePickerProps = {
  options: ChatServiceOptionEntry[];
  value: string;
  onChange: (v: string) => void;
};

function ServicePicker({ options, value, onChange }: ServicePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const label = selected
    ? `${selected.peerLabel || 'peer'} · ${normalizeServiceName(selected.label)}`
    : 'Select a service';

  return (
    <div ref={wrapperRef} className={styles.pickerWrap}>
      <button
        type="button"
        className={styles.pickerTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={styles.pickerTriggerLabel}>{label}</span>
        <svg
          className={`${styles.pickerChevron}${open ? ` ${styles.pickerChevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.pickerPopover} role="listbox">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`${styles.pickerOption}${active ? ` ${styles.pickerOptionActive}` : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className={styles.pickerOptionPeer}>{opt.peerLabel || 'peer'}</span>
                <span className={styles.pickerOptionService}>{normalizeServiceName(opt.label)}</span>
                {active && (
                  <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} className={styles.pickerOptionTick} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
      <div className={`page-header ${styles.pageHeader}`}>
        <div className={styles.pageHeadingGroup}>
          <span className={styles.eyebrow}>Developer</span>
          <h2>API</h2>
        </div>
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

      <div className={styles.content}>
        <div className={styles.twoCol}>
          {/* ── LEFT: Documentation ── */}
          <div className={styles.leftCol}>
            <div className={styles.heroBlock}>
              <span className={styles.eyebrow}>Local endpoint</span>
              <div className={styles.endpointRow}>
                <span className={styles.endpointMethod}>HTTP</span>
                <code className={styles.endpointUrl}>http://localhost:{displayPort}</code>
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

            <div className={styles.divider} />

            <div className={styles.docsRow}>
              <button className={styles.docsCta} onClick={openDocs}>
                <HugeiconsIcon icon={BookOpen01Icon} size={14} strokeWidth={1.6} />
                <span>Read the API docs</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.6} className={styles.docsCtaArrow} />
              </button>
            </div>

            <div className={styles.clientLinks}>
              <span className={styles.sectionLabel}>External clients</span>
              <div className={styles.clientGrid}>
                {TOOLS.map((tool) => {
                  const Logo = tool.Logo;
                  const brandStyle = { '--brand': tool.brand } as CSSProperties;
                  return (
                    <button
                      key={tool.tag}
                      className={styles.clientCard}
                      onClick={() => setOpenTool(tool)}
                    >
                      <span className={styles.clientCardLogo} style={brandStyle}>
                        <Logo width={18} height={18} />
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
                <ServicePicker
                  options={freeOptions}
                  value={tryServiceValue}
                  onChange={handleSelectFreeService}
                />
              ) : (
                <span className={styles.targetEmpty}>No free services discovered yet</span>
              )}
            </div>

            <div className={styles.codeWindow}>
              <div className={styles.codeWindowHead}>
                <span className={styles.codeWindowDots} aria-hidden="true">
                  <span /><span /><span />
                </span>
                <span className={styles.codeWindowLabel}>request · curl</span>
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
            </div>

            <div className={styles.responseWindow}>
              <div className={styles.responseWindowHead}>
                <span className={styles.codeWindowLabel}>response</span>
                {tryState.kind === 'result' && (
                  <span
                    className={`${styles.statusPill} ${tryState.status >= 400 ? styles.statusPillError : styles.statusPillOk}`}
                  >
                    HTTP {tryState.status}
                  </span>
                )}
                {tryState.kind === 'error' && (
                  <span className={`${styles.statusPill} ${styles.statusPillError}`}>error</span>
                )}
                {tryState.kind === 'loading' && (
                  <span className={`${styles.statusPill} ${styles.statusPillPending}`}>pending</span>
                )}
              </div>
              <div className={styles.responseBodyWrap}>
                {tryState.kind === 'idle' && (
                  <div className={styles.responsePlaceholder}>
                    <span className={styles.responsePlaceholderDot} />
                    Response will appear here.
                  </div>
                )}
                {tryState.kind === 'loading' && (
                  <div className={styles.responsePlaceholder}>
                    <span className={`${styles.responsePlaceholderDot} ${styles.dotPulse}`} />
                    Waiting for peer…
                  </div>
                )}
                {tryState.kind === 'error' && (
                  <pre className={`${styles.responseBody} ${styles.responseError}`}>
                    <code>{tryState.error}</code>
                  </pre>
                )}
                {tryState.kind === 'result' && (
                  <pre className={styles.responseBody}>
                    <code>{formatResponse(tryState.status, tryState.body)}</code>
                  </pre>
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
