import { useState, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import styles from './ExternalClientsView.module.scss';

type ExternalClientsViewProps = {
  active: boolean;
};

type Step = { label: string; command?: string };

type Tool = {
  name: string;
  tag: string;
  format: 'anthropic' | 'openai';
  description: string;
  steps: Step[];
  envVar: string;
  getEndpoint: (port: number) => string;
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
    name: 'Any OpenAI-compatible tool',
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

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <button
      className={`${styles.copyBtn}${copied ? ` ${styles.copied}` : ''}`}
      onClick={handleCopy}
    >
      {copied ? '✓ Copied' : (label ?? 'Copy')}
    </button>
  );
}

function ToolCard({ tool, port, isOnline }: { tool: Tool; port: number; isOnline: boolean }) {
  const displayPort = isOnline ? port : 8377;
  const endpoint = tool.getEndpoint(displayPort);
  const exportLine = tool.format === 'openai'
    ? `export ${tool.envVar}=${endpoint}`
    : `export ${tool.envVar}=${endpoint}`;
  const persistLine = tool.persist.replace(/{port}/g, String(displayPort));

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolHeader}>
        <div className={styles.toolIcon}>
          <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} strokeWidth={1.5} />
        </div>
        <div className={styles.toolMeta}>
          <span className={styles.toolName}>{tool.name}</span>
          <span className={`${styles.toolFormat} ${tool.format === 'anthropic' ? styles.formatAnthropic : styles.formatOpenai}`}>
            {tool.format === 'anthropic' ? 'Anthropic format' : 'OpenAI format'}
          </span>
        </div>
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
  );
}

export function ExternalClientsView({ active }: ExternalClientsViewProps) {
  const { chatProxyStatus, chatProxyPort } = useUiSnapshot();
  const isOnline = chatProxyStatus.tone === 'active' && chatProxyPort > 0;

  return (
    <section className={`view ${styles.view}${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>External Clients</h2>
        <div className={`${styles.proxyBadge} ${isOnline ? styles.proxyOnline : styles.proxyOffline}`}>
          <span className={styles.proxyBadgeDot} />
          {isOnline ? `Proxy active · :${chatProxyPort}` : 'Proxy offline'}
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.intro}>
          <p className={styles.introText}>
            AntSeed runs a local proxy that routes your AI requests to the best peer on the network.
            Any tool that supports a custom API endpoint works out of the box — no API keys needed, just point it at the proxy.
          </p>
          {!isOnline && (
            <div className={styles.offlineNote}>
              Start the buyer runtime from the Overview page to bring the proxy online.
            </div>
          )}
        </div>

        <div className={styles.toolGrid}>
          {TOOLS.map((tool) => (
            <ToolCard key={tool.tag} tool={tool} port={chatProxyPort} isOnline={isOnline} />
          ))}
        </div>
      </div>
    </section>
  );
}
