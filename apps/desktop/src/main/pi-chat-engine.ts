import { app, BrowserWindow } from 'electron';
import type { IpcMain } from 'electron';
import { type Static, Type } from '@sinclair/typebox';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentSession, AgentSessionEvent, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { ANTSTATION_SYSTEM_PROMPT } from './chat-system-prompt.js';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
  Usage,
} from '@mariozechner/pi-ai';

type TextBlock = { type: 'text'; text: string };
type ThinkingBlock = { type: 'thinking'; thinking: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  details?: Record<string, unknown>;
};
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

type AiMessageMeta = {
  peerId?: string;
  peerAddress?: string;
  peerProviders?: string[];
  peerReputation?: number;
  peerTrustScore?: number;
  peerCurrentLoad?: number;
  peerMaxConcurrency?: number;
  provider?: string;
  service?: string;
  requestId?: string;
  routeRequestId?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokenSource?: 'usage' | 'estimated' | 'unknown';
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  estimatedCostUsd?: number;
};

type AiChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  createdAt?: number;
  meta?: AiMessageMeta;
};

type AiUsageTotals = {
  inputTokens: number;
  outputTokens: number;
};

type AiConversation = {
  id: string;
  title: string;
  service: string;
  provider?: string;
  messages: AiChatMessage[];
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
};

type AiConversationSummary = {
  id: string;
  title: string;
  service: string;
  provider?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
  totalTokens: number;
  totalEstimatedCostUsd: number;
};

const WEB_FETCH_MAX_CHARS_DEFAULT = 20_000;
const WEB_FETCH_MAX_CHARS_LIMIT = 50_000;
const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'The HTTP or HTTPS URL to fetch.',
  }),
  maxChars: Type.Optional(Type.Number({
    description: `Maximum number of response characters to return (default ${WEB_FETCH_MAX_CHARS_DEFAULT}, max ${WEB_FETCH_MAX_CHARS_LIMIT}).`,
    minimum: 100,
    maximum: WEB_FETCH_MAX_CHARS_LIMIT,
  })),
});

function stripHtmlToText(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|section|article|main|header|footer|aside|nav|li|ul|ol|h[1-6]|br|tr|td|th|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Heuristic: HTML that looks like a JS-rendered SPA (very little visible text, React/Next.js markers).
// Accepts pre-stripped text to avoid running stripHtmlToText twice.
function looksLikeJsRequired(rawHtml: string, strippedText: string): boolean {
  // Fewer than 200 chars of visible text → likely needs JS to render
  if (strippedText.length < 200) return true;
  // Common SPA root patterns (empty root/app div)
  if (/<div[^>]+id=["'](?:root|__next|app|app-root|react-root|app-container|main-app)["'][^>]*>\s*<\/div>/i.test(rawHtml)) return true;
  return false;
}

// Persistent hidden BrowserWindow reused across web_fetch calls to avoid per-call renderer startup cost.
let _headlessBrowser: BrowserWindow | null = null;

function getHeadlessBrowser(): BrowserWindow {
  if (_headlessBrowser && !_headlessBrowser.isDestroyed()) return _headlessBrowser;
  _headlessBrowser = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      javascript: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  _headlessBrowser.on('closed', () => { _headlessBrowser = null; });
  return _headlessBrowser;
}

// Serializes headless requests so concurrent calls don't clobber each other
// (loading a new URL aborts the previous one, which would fire did-fail-load).
let _headlessQueue: Promise<void> = Promise.resolve();

// Extract readable text from a fully rendered page using Electron's built-in Chromium
function fetchWithHeadlessBrowser(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const result = _headlessQueue.then(() => _fetchHeadlessSerial(url, timeoutMs, signal));
  _headlessQueue = result.then(() => {}, () => {});
  return result;
}

function _fetchHeadlessSerial(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }

    const win = getHeadlessBrowser();
    let settled = false;

    const onFailLoad = (_event: Electron.Event, errorCode: number, errorDescription: string) => {
      settle(new Error(`Page load failed: ${errorDescription} (${String(errorCode)})`));
    };
    const onFinishLoad = () => {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(`
            (function() {
              ['script','style','noscript','nav','footer','aside','iframe'].forEach(function(tag) {
                document.querySelectorAll(tag).forEach(function(el) { el.remove(); });
              });
              var title = document.title ? document.title + '\\n\\n' : '';
              var text = (document.body && document.body.innerText) ? document.body.innerText : document.documentElement.innerText || '';
              return title + text;
            })()
          `)
          .then((text: unknown) => {
            const result = typeof text === 'string' ? text.replace(/\n{2,}/g, '\n').trim() : '';
            settle(result);
          })
          .catch((err: unknown) => {
            settle(err instanceof Error ? err : new Error(String(err)));
          });
      }, 1500);
    };

    const settle = (result: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-fail-load', onFailLoad);
      win.webContents.removeListener('did-finish-load', onFinishLoad);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const timer = setTimeout(() => settle(new Error('Headless browser timed out')), timeoutMs);
    const onAbort = () => settle(new Error('web_fetch aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    win.webContents.once('did-fail-load', onFailLoad);
    win.webContents.once('did-finish-load', onFinishLoad);

    win.loadURL(url).catch((err: unknown) => {
      settle(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Fetch a public HTTP/HTTPS URL and return the page content as readable text. Handles both static pages and JavaScript-rendered sites (news, SPAs, etc.). Always use this tool instead of curl or bash for web content.',
  parameters: WebFetchParams,
  async execute(_toolCallId, params, signal) {
    const typedParams = params as Static<typeof WebFetchParams>;
    const parsedUrl = new URL(typedParams.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('web_fetch only supports http:// and https:// URLs');
    }

    const requestedMaxChars =
      typeof typedParams.maxChars === 'number' ? typedParams.maxChars : WEB_FETCH_MAX_CHARS_DEFAULT;
    const maxChars = Math.max(
      100,
      Math.min(
        WEB_FETCH_MAX_CHARS_LIMIT,
        Math.floor(requestedMaxChars),
      ),
    );

    // Fast path: plain fetch first
    const timeoutSignal = AbortSignal.timeout(15_000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(parsedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: fetchSignal,
      headers: {
        'user-agent': app.userAgentFallback ?? 'Mozilla/5.0 AntStation/web_fetch',
        accept: 'text/html,application/json,text/plain,application/xml,text/xml,*/*;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') ?? 'unknown';
    const isHtml = /\btext\/html\b/i.test(contentType);

    let normalizedText: string;
    let usedHeadless = false;

    if (isHtml) {
      const rawText = await response.text();
      const stripped = stripHtmlToText(rawText);
      if (looksLikeJsRequired(rawText, stripped)) {
        // Fall back to headless Chromium for JS-rendered pages
        usedHeadless = true;
        try {
          normalizedText = await fetchWithHeadlessBrowser(parsedUrl.toString(), 30_000, signal ?? undefined);
          if (!normalizedText) normalizedText = stripped; // headless returned empty, use raw
        } catch {
          normalizedText = stripped; // headless failed, use raw strip
        }
      } else {
        normalizedText = stripped;
      }
    } else {
      const rawText = await response.text();
      // Clip before trim to avoid buffering megabytes unnecessarily
      normalizedText = rawText.slice(0, maxChars * 4).trim();
    }

    const truncated = normalizedText.length > maxChars;
    const body = truncated ? `${normalizedText.slice(0, maxChars)}\n\n[truncated]` : normalizedText;
    const renderedNote = usedHeadless ? ' (JS-rendered via headless browser)' : '';

    return {
      content: [
        {
          type: 'text',
          text: `URL: ${response.url}\nStatus: ${response.status} ${response.statusText}\nContent-Type: ${contentType}${renderedNote}\n\n${body}`,
        },
      ],
      details: {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        contentType,
        truncated,
        usedHeadless,
      },
    };
  },
};

const BrowserPreviewParams = Type.Object({
  url: Type.String({
    description: 'The URL to open in the browser preview panel (e.g. http://localhost:3000).',
  }),
});

function createBrowserPreviewTool(
  sendToRenderer: (channel: string, payload: unknown) => void,
): ToolDefinition {
  return {
    name: 'open_browser_preview',
    label: 'Browser Preview',
    description:
      'Open a URL in the built-in browser preview panel beside the chat. ' +
      'Use this when working on web development to let the user see their website, ' +
      'app, or UI live alongside the conversation. The preview panel is an embedded ' +
      'browser that renders the page — ideal for localhost dev servers (e.g. ' +
      'http://localhost:3000, http://localhost:5173) or any URL the user is building. ' +
      'Call this tool after starting a dev server with start_dev_server, when making ' +
      'visible UI changes, or when the user asks to preview their work.',
    parameters: BrowserPreviewParams,
    async execute(_toolCallId, params) {
      const { url } = params as Static<typeof BrowserPreviewParams>;
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid URL: ${url}` }],
          details: { url, error: 'invalid URL' },
          isError: true,
        };
      }
      sendToRenderer('browser-preview:open', { url });
      return {
        content: [
          {
            type: 'text',
            text: `Opened browser preview for ${url}. The user can now see the page in the panel to the right of this chat.`,
          },
        ],
        details: { url },
      };
    },
  };
}

const StartDevServerParams = Type.Object({
  command: Type.String({
    description:
      'The shell command to start the dev server, e.g. "pnpm run dev", "npm run dev", "npx vite", "docusaurus start".',
  }),
  cwd: Type.String({
    description: 'Absolute path to the project directory where the command should run.',
  }),
  port: Type.Optional(
    Type.Number({
      description:
        'Expected port the server will listen on. If omitted, the tool scans the output for a URL.',
    }),
  ),
});

/** Track running dev servers so we can kill them on new starts. */
const runningDevServers = new Map<string, { pid: number; kill: () => void }>();

function getDevServerShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env['ComSpec']?.trim() || 'cmd.exe';
    return {
      file: comspec,
      args: ['/d', '/s', '/c', command],
    };
  }

  const shell = process.env['SHELL']?.trim() || '/bin/bash';
  return {
    file: shell,
    args: ['-lc', command],
  };
}

function killDetachedDevServer(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }

  process.kill(-pid, 'SIGTERM');
}

function waitForPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (signal?.aborted) { resolve(false); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      const sock = createConnection({ host: '127.0.0.1', port });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => { setTimeout(check, 500); });
    };
    check();
  });
}

function extractUrlFromOutput(output: string): string | null {
  // Match common dev server URL patterns
  const m = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?/);
  return m ? m[0].replace('0.0.0.0', 'localhost') : null;
}

const startDevServerTool: ToolDefinition = {
  name: 'start_dev_server',
  label: 'Start Dev Server',
  description:
    'Start a development server as a persistent background process. The server runs in ' +
    'a detached session so it survives tool timeouts. Use this instead of bash for any ' +
    'long-running dev server (npm run dev, pnpm run dev, vite, next dev, docusaurus start, etc.). ' +
    'The tool waits for the server to be ready and returns the URL. After this, call ' +
    'open_browser_preview with the returned URL to show it in the preview panel.',
  parameters: StartDevServerParams,
  async execute(_toolCallId, params, signal) {
    const { command, cwd, port: expectedPort } = params as Static<typeof StartDevServerParams>;

    if (!existsSync(cwd)) {
      return {
        content: [{ type: 'text', text: `Directory does not exist: ${cwd}` }],
        details: { cwd, error: 'directory not found' },
        isError: true,
      };
    }

    // Kill any previously started server in the same directory
    const prev = runningDevServers.get(cwd);
    if (prev) {
      try { prev.kill(); } catch { /* ignore */ }
      runningDevServers.delete(cwd);
    }

    let output = '';

    const shellCommand = getDevServerShell(command);
    const child = spawn(shellCommand.file, shellCommand.args, {
      cwd,
      detached: true, // new process group — immune to parent signals
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
      windowsHide: true,
    });

    if (!child.pid) {
      return {
        content: [{ type: 'text', text: `Failed to start dev server for command: ${command}` }],
        details: { cwd, command, error: 'missing child pid' },
        isError: true,
      };
    }

    // Unref so the Electron process can exit even if the dev server is still running
    child.unref();

    const collectOutput = (chunk: Buffer) => {
      output += chunk.toString();
      // Cap collected output to avoid unbounded memory
      if (output.length > 32_000) output = output.slice(-16_000);
    };

    let spawnError: string | null = null;
    let exitCode: number | null = null;

    child.stdout?.on('data', collectOutput);
    child.stderr?.on('data', collectOutput);
    child.on('error', (error) => {
      spawnError = error.message;
      output += `\n[spawn error] ${error.message}`;
    });
    child.on('exit', (code) => {
      exitCode = code;
    });

    const killFn = () => {
      try { killDetachedDevServer(child.pid!); } catch { /* ignore */ }
    };

    runningDevServers.set(cwd, { pid: child.pid, kill: killFn });

    // Wait for the server to become ready
    const startTime = Date.now();
    const maxWaitMs = 30_000;

    // If we know the port, poll for it
    if (expectedPort) {
      const ready = await waitForPort(expectedPort, maxWaitMs, signal ?? undefined);
      if (ready) {
        const url = `http://localhost:${expectedPort}`;
        return {
          content: [{ type: 'text', text: `Dev server running at ${url} (pid ${child.pid})` }],
          details: { url, pid: child.pid, cwd },
        };
      }
    }

    // Otherwise, watch the output for a URL
    const foundUrl = await new Promise<string | null>((resolve) => {
      const deadline = startTime + maxWaitMs;

      const poll = () => {
        if (signal?.aborted) { resolve(null); return; }
        const url = extractUrlFromOutput(output);
        if (url) { resolve(url); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(poll, 500);
      };
      poll();
    });

    if (foundUrl) {
      // Give it a tiny bit more time after URL appears (compilation may still be running)
      const port = parseInt(new URL(foundUrl).port, 10);
      if (port) await waitForPort(port, 10_000, signal ?? undefined);

      return {
        content: [{ type: 'text', text: `Dev server running at ${foundUrl} (pid ${child.pid})` }],
        details: { url: foundUrl, pid: child.pid, cwd },
      };
    }

    if (spawnError || exitCode !== null) {
      const tail = output.slice(-2000);
      return {
        content: [
          {
            type: 'text',
            text: `Dev server failed to stay running for command "${command}".\n\nOutput tail:\n${tail}`,
          },
        ],
        details: { pid: child.pid, cwd, command, spawnError, exitCode, outputTail: tail },
        isError: true,
      };
    }

    // Server didn't produce a URL — return what we have
    const tail = output.slice(-2000);
    return {
      content: [
        {
          type: 'text',
          text: `Dev server started (pid ${child.pid}) but no URL detected within ${maxWaitMs / 1000}s.\n\nOutput tail:\n${tail}`,
        },
      ],
      details: { pid: child.pid, cwd, outputTail: tail },
    };
  },
};

type RegisterPiChatHandlersOptions = {
  ipcMain: IpcMain;
  sendToRenderer: (channel: string, payload: unknown) => void;
  configPath: string;
  isBuyerRuntimeRunning: () => boolean;
  ensureBuyerRuntimeStarted?: () => Promise<boolean>;
  appendSystemLog: (line: string) => void;
  getNetworkPeers?: () => Promise<NetworkPeerAddress[]>;
};

type SessionPathInfo = {
  path: string;
  id: string;
};

type ActiveRun = {
  conversationId: string;
  session: AgentSession;
  unsubscribe: () => void;
};

type NetworkPeerAddress = {
  peerId?: string;
  displayName?: string;
  host: string;
  port: number;
  providers?: string[];
  services?: string[];
};

type ChatServiceProtocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';
type ChatPermissionMode = 'default' | 'full-access';

type ChatServiceCatalogEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: ChatServiceProtocol;
  count: number;
  peerId?: string;
  peerLabel?: string;
};

const ANTSEED_HOME_DIR = path.join(homedir(), '.antseed');
const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
const CHAT_SESSIONS_DIR = path.join(CHAT_DATA_DIR, 'sessions');
const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
const CHAT_AGENT_DIR = path.join(CHAT_DATA_DIR, 'pi-agent');
const CHAT_WORKSPACE_STATE_FILE = path.join(CHAT_DATA_DIR, 'workspace.json');

const DEFAULT_PROXY_PORT = 8377;
const DEFAULT_CHAT_SERVICE = 'claude-sonnet-4-20250514';
const PROXY_PROVIDER_ID = 'antseed-proxy';
const PROXY_RUNTIME_API_KEY = 'antseed-local';

const CHAT_SYSTEM_PROMPT_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT';
const CHAT_SYSTEM_PROMPT_FILE_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT_FILE';
const CHAT_SERVICE_SCAN_MAX_PEERS = 20;
const CHAT_SERVICE_MAX_OPTIONS = 120;
const CHAT_SERVICE_MAX_OPTIONS_PER_PROVIDER = 40;
const CHAT_DEFAULT_ACTIVE_TOOL_NAMES = [
  'read',
  'grep',
  'find',
  'ls',
  'edit',
  'write',
  'web_fetch',
  'open_browser_preview',
  'start_dev_server',
] as const;
const CHAT_FULL_ACCESS_TOOL_NAMES = [...CHAT_DEFAULT_ACTIVE_TOOL_NAMES, 'bash'] as const;

type ChatWorkspaceGitStatus = {
  available: boolean;
  rootPath: string | null;
  branch: string | null;
  isDetached: boolean;
  ahead: number;
  behind: number;
  stagedFiles: number;
  modifiedFiles: number;
  untrackedFiles: number;
  error: string | null;
};

const execFileAsync = promisify(execFileCallback);

let currentChatWorkspaceDir = CHAT_WORKSPACE_DIR;

function getCurrentChatWorkspaceDir(): string {
  return currentChatWorkspaceDir;
}

async function loadChatWorkspaceDir(): Promise<string> {
  try {
    const raw = await readFile(CHAT_WORKSPACE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { path?: unknown };
    const savedPath = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    if (savedPath && existsSync(savedPath)) {
      currentChatWorkspaceDir = savedPath;
    }
  } catch {
    // Keep default workspace dir.
  }
  return currentChatWorkspaceDir;
}

async function persistChatWorkspaceDir(workspaceDir: string): Promise<string> {
  const trimmed = workspaceDir.trim();
  if (!trimmed) {
    throw new Error('Workspace path is required');
  }
  if (!existsSync(trimmed)) {
    throw new Error(`Workspace does not exist: ${trimmed}`);
  }
  await mkdir(CHAT_DATA_DIR, { recursive: true });
  await writeFile(CHAT_WORKSPACE_STATE_FILE, JSON.stringify({ path: trimmed }, null, 2), 'utf8');
  currentChatWorkspaceDir = trimmed;
  return currentChatWorkspaceDir;
}

function normalizeChatPermissionMode(value: unknown): ChatPermissionMode {
  return value === 'full-access' ? 'full-access' : 'default';
}

function resolveChatActiveToolNames(permissionMode: ChatPermissionMode): string[] {
  return permissionMode === 'full-access'
    ? [...CHAT_FULL_ACCESS_TOOL_NAMES]
    : [...CHAT_DEFAULT_ACTIVE_TOOL_NAMES];
}

async function getWorkspaceGitStatus(workspaceDir: string): Promise<ChatWorkspaceGitStatus> {
  if (!workspaceDir.trim()) {
    return {
      available: false,
      rootPath: null,
      branch: null,
      isDetached: false,
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      untrackedFiles: 0,
      error: 'Workspace path is empty',
    };
  }

  try {
    const [{ stdout: rootStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync('git', ['status', '--porcelain=2', '--branch'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
    ]);

    const result: ChatWorkspaceGitStatus = {
      available: true,
      rootPath: rootStdout.trim() || null,
      branch: null,
      isDetached: false,
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      untrackedFiles: 0,
      error: null,
    };

    for (const line of statusStdout.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim();
        result.isDetached = head === '(detached)';
        result.branch = result.isDetached ? 'detached' : head;
        continue;
      }
      if (line.startsWith('# branch.ab ')) {
        const match = /# branch\.ab \+(\d+) -(\d+)/.exec(line);
        if (match) {
          result.ahead = Number(match[1]) || 0;
          result.behind = Number(match[2]) || 0;
        }
        continue;
      }
      if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
        const fields = line.split(' ');
        const xy = fields[1] ?? '..';
        const x = xy[0] ?? '.';
        const y = xy[1] ?? '.';
        if (x !== '.') result.stagedFiles += 1;
        if (y !== '.') result.modifiedFiles += 1;
        continue;
      }
      if (line.startsWith('? ')) {
        result.untrackedFiles += 1;
      }
    }

    return result;
  } catch (error) {
    const message = asErrorMessage(error);
    const isNoRepo = /not a git repository|no such file or directory/i.test(message);
    return {
      available: false,
      rootPath: null,
      branch: null,
      isDetached: false,
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      untrackedFiles: 0,
      error: isNoRepo ? null : message,
    };
  }
}

function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}


function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function normalizeServiceId(service?: string): string {
  const trimmed = String(service ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CHAT_SERVICE;
}

function isChatServiceProtocol(value: unknown): value is ChatServiceProtocol {
  return value === 'anthropic-messages'
    || value === 'openai-chat-completions'
    || value === 'openai-responses';
}

function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function inferProviderProtocol(provider: string): ChatServiceProtocol | null {
  if (provider === 'openai-responses') {
    return 'openai-responses';
  }
  if (provider === 'openai' || provider === 'openrouter' || provider === 'local-llm') {
    return 'openai-chat-completions';
  }
  if (provider === 'anthropic' || provider === 'claude-code' || provider === 'claude-oauth') {
    return 'anthropic-messages';
  }
  return null;
}




function normalizeServiceValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const service = value.trim();
  return service.length > 0 ? service : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}



function updateServiceProviderHints(
  serviceProviderHints: Map<string, string[]>,
  entries: ChatServiceCatalogEntry[],
): void {
  serviceProviderHints.clear();
  for (const entry of entries) {
    const serviceId = normalizeServiceValue(entry.id)?.toLowerCase();
    const provider = normalizeProviderId(entry.provider);
    if (!serviceId || !provider || !inferProviderProtocol(provider)) {
      continue;
    }
    const providers = serviceProviderHints.get(serviceId) ?? [];
    if (!providers.includes(provider)) {
      providers.push(provider);
      serviceProviderHints.set(serviceId, providers);
    }
  }
}

function updateServiceProtocolMap(
  serviceProtocolMap: Map<string, ChatServiceProtocol>,
  entries: ChatServiceCatalogEntry[],
): void {
  serviceProtocolMap.clear();
  for (const entry of entries) {
    const serviceId = normalizeServiceValue(entry.id)?.toLowerCase();
    if (!serviceId) continue;
    // First entry wins — the catalog is sorted by popularity (count desc)
    if (!serviceProtocolMap.has(serviceId)) {
      serviceProtocolMap.set(serviceId, entry.protocol);
    }
  }
}

function resolveProviderHintForService(
  explicitProvider?: string,
): string | null {
  const explicit = normalizeProviderId(explicitProvider);
  if (explicit && inferProviderProtocol(explicit)) {
    return explicit;
  }
  return null;
}

function normalizePeerId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const peerId = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(peerId) ? peerId : null;
}

function normalizeChatServiceCatalogEntry(raw: unknown): ChatServiceCatalogEntry | null {
  const entry = asRecord(raw);
  if (!entry) {
    return null;
  }

  const id = normalizeServiceValue(entry.id);
  const provider = normalizeProviderId(entry.provider);
  const protocol = entry.protocol;
  if (!id || !provider || !isChatServiceProtocol(protocol) || !inferProviderProtocol(provider)) {
    return null;
  }

  const count = Number(entry.count);
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.max(1, Math.floor(count)) : 1;
  const label = normalizeServiceValue(entry.label) ?? id;
  return {
    id,
    label,
    provider,
    protocol,
    count: normalizedCount,
  };
}

function normalizeChatServiceCatalogEntries(rawEntries: unknown[]): ChatServiceCatalogEntry[] {
  const deduped = new Map<string, ChatServiceCatalogEntry>();
  for (const rawEntry of rawEntries) {
    const entry = normalizeChatServiceCatalogEntry(rawEntry);
    if (!entry) {
      continue;
    }
    const key = `${entry.id}\u0000${entry.provider}\u0000${entry.protocol}`;
    const existing = deduped.get(key);
    if (existing) {
      existing.count = Math.max(existing.count, entry.count);
      continue;
    }
    deduped.set(key, { ...entry });
  }
  return sortChatServiceCatalogEntries([...deduped.values()]);
}

function sortChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
  const protocolRank = (protocol: ChatServiceProtocol): number => (
    protocol === 'anthropic-messages'
      ? 0
      : protocol === 'openai-chat-completions'
        ? 1
        : 2
  );

  return entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (protocolRank(a.protocol) !== protocolRank(b.protocol)) {
      return protocolRank(a.protocol) - protocolRank(b.protocol);
    }
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    return a.id.localeCompare(b.id);
  });
}

function limitChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
  if (entries.length <= CHAT_SERVICE_MAX_OPTIONS) {
    return entries;
  }

  const limited: ChatServiceCatalogEntry[] = [];
  const perProviderCount = new Map<string, number>();
  for (const entry of entries) {
    const provider = entry.provider;
    const providerCount = perProviderCount.get(provider) ?? 0;
    if (providerCount >= CHAT_SERVICE_MAX_OPTIONS_PER_PROVIDER) {
      continue;
    }
    limited.push(entry);
    perProviderCount.set(provider, providerCount + 1);
    if (limited.length >= CHAT_SERVICE_MAX_OPTIONS) {
      break;
    }
  }

  return limited;
}

/**
 * Build the chat service catalog directly from peer data (already in buyer.state.json).
 * No HTTP metadata fetches needed — providers and services are in the peer list.
 */
async function discoverChatServiceCatalog(
  getNetworkPeers?: () => Promise<NetworkPeerAddress[]>,
): Promise<ChatServiceCatalogEntry[]> {
  // Read peers directly from buyer.state.json for immediate availability.
  // Falls back to the getNetworkPeers callback if the file isn't available.
  let peers: NetworkPeerAddress[] = [];
  try {
    const { readFile } = await import('node:fs/promises');
    const { DEFAULT_BUYER_STATE_PATH } = await import('./constants.js');
    const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawPeers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
    peers = rawPeers
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map((p) => ({
        peerId: typeof p.peerId === 'string' ? p.peerId : '',
        displayName: typeof p.displayName === 'string' ? p.displayName : undefined,
        host: '',
        port: 0,
        providers: Array.isArray(p.providers) ? p.providers.map(String) : [],
        services: Array.isArray(p.services) ? p.services.map(String) : [],
      }))
      .filter((p) => p.peerId.length > 0);
  } catch {
    // File not ready yet — try the callback
    if (!getNetworkPeers) return [];
    try {
      peers = await getNetworkPeers();
    } catch {
      return [];
    }
  }

  const results: ChatServiceCatalogEntry[] = [];
  for (const peer of peers.slice(0, CHAT_SERVICE_SCAN_MAX_PEERS)) {
    const peerId = peer.peerId;
    const peerLabel = peer.displayName
      ? `${peer.displayName} (${peerId?.slice(0, 8) ?? ''})`
      : peerId ? peerId.slice(0, 12) + '...' : undefined;

    const providerList = peer.providers ?? [];
    const serviceList = peer.services ?? [];

    if (serviceList.length > 0) {
      // Use explicit service names when available.
      for (const serviceId of serviceList) {
        // Infer provider from the service name or fall back to the first provider.
        const provider = providerList.find((p) => inferProviderProtocol(p) !== null) ?? providerList[0] ?? 'unknown';
        const protocol = inferProviderProtocol(provider);
        if (!protocol) continue;

        results.push({
          id: serviceId,
          label: serviceId,
          provider,
          protocol,
          count: 1,
          peerId,
          peerLabel,
        });
      }
    } else if (providerList.length > 0) {
      // No services listed — create one entry per provider as a fallback.
      for (const provider of providerList) {
        const protocol = inferProviderProtocol(provider);
        if (!protocol) continue;

        results.push({
          id: provider,
          label: provider,
          provider,
          protocol,
          count: 1,
          peerId,
          peerLabel,
        });
      }
    }
  }

  return sortChatServiceCatalogEntries(results);
}



function toUsage(value: unknown): Usage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const input = normalizeTokenCount(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count,
  );
  const output = normalizeTokenCount(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  );
  const cacheRead = normalizeTokenCount(usage.cacheRead ?? usage.cache_read_input_tokens);
  const cacheWrite = normalizeTokenCount(usage.cacheWrite ?? usage.cache_creation_input_tokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens ?? usage.total_tokens) || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.input) ?? 0,
      output: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.output) ?? 0,
      cacheRead: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheRead) ?? 0,
      cacheWrite: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheWrite) ?? 0,
      total: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.total) ?? 0,
    },
  };
}

function mergeUsage(base: AiUsageTotals, delta: AiUsageTotals): AiUsageTotals {
  return {
    inputTokens: normalizeTokenCount(base.inputTokens) + normalizeTokenCount(delta.inputTokens),
    outputTokens: normalizeTokenCount(base.outputTokens) + normalizeTokenCount(delta.outputTokens),
  };
}

function ensureUsageShape(base?: Partial<Usage>): Usage {
  const initial = base ?? {};
  const usage = toUsage(initial);
  return usage;
}

function convertToolContentToText(content: Array<TextContent | { type: 'image'; mimeType: string; data: string }>): string {
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    parts.push(`[image:${block.mimeType}]`);
  }
  return parts.join('\n').trim();
}

function isToolArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertPiMessageToUiBlocks(message: Message): string | ContentBlock[] {
  if (message.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
      if (!block) continue;
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: block.thinking });
        continue;
      }
      if (block.type === 'toolCall') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.arguments ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }

  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return message.content;
    }
    // Preserve image blocks so the UI can render them
    const hasImage = message.content.some((block) => block.type === 'image');
    if (hasImage) {
      const blocks: ContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'image') {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: (block as ImageContent).mimeType, data: (block as ImageContent).data },
          } as unknown as ContentBlock);
        } else if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
        }
      }
      return blocks;
    }
    const textParts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      }
    }
    return textParts.join('\n').trim();
  }

  const toolResult = message as ToolResultMessage;
  return [{
    type: 'tool_result',
    tool_use_id: toolResult.toolCallId,
    content: convertToolContentToText(toolResult.content),
    is_error: toolResult.isError,
    details:
      toolResult.details && typeof toolResult.details === 'object'
        ? (toolResult.details as Record<string, unknown>)
        : undefined,
  }];
}

function convertPiMessagesToUi(messages: Message[]): AiChatMessage[] {
  const converted: AiChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: convertPiMessageToUiBlocks(message),
        createdAt: normalizeTokenCount(message.timestamp),
      });
      continue;
    }

    if (message.role === 'assistant') {
      converted.push(
        convertAssistantMessageForUi(
          message as AssistantMessage & { meta?: AiMessageMeta },
        ),
      );
      continue;
    }

    if (message.role === 'toolResult') {
      const toolResultBlocks = convertPiMessageToUiBlocks(message);
      const last = converted[converted.length - 1];
      const toolBlocks = Array.isArray(toolResultBlocks)
        ? toolResultBlocks.filter((entry): entry is ToolResultBlock => entry.type === 'tool_result')
        : [];
      if (
        last
        && last.role === 'user'
        && Array.isArray(last.content)
        && last.content.every((entry) => entry.type === 'tool_result')
        && toolBlocks.length > 0
      ) {
        last.content.push(...toolBlocks);
      } else {
        converted.push({
          role: 'user',
          content: toolBlocks,
          createdAt: normalizeTokenCount(message.timestamp),
        });
      }
    }
  }
  return converted;
}

function deriveUsage(messages: AiChatMessage[]): AiUsageTotals {
  let usage: AiUsageTotals = { inputTokens: 0, outputTokens: 0 };
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    usage = mergeUsage(usage, {
      inputTokens: normalizeTokenCount(message.meta?.inputTokens),
      outputTokens: normalizeTokenCount(message.meta?.outputTokens),
    });
  }
  return usage;
}

function deriveCost(messages: AiChatMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== 'assistant') {
      return sum;
    }
    const value = Number(message.meta?.estimatedCostUsd);
    if (!Number.isFinite(value) || value <= 0) {
      return sum;
    }
    return sum + value;
  }, 0);
}

function deriveTitle(messages: AiChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
    }
  }
  return 'New conversation';
}

function makeProxyService(
  serviceId: string,
  port: number,
  protocol: ChatServiceProtocol = 'anthropic-messages',
  providerHint?: string | null,
  preferredPeerId?: string | null,
  spendingAuth?: string | null,
): Model<any> {
  const headers: Record<string, string> = {};
  if (providerHint) headers['x-antseed-provider'] = providerHint;
  if (preferredPeerId) headers['x-antseed-pin-peer'] = preferredPeerId;
  if (spendingAuth) headers['x-antseed-spending-auth'] = spendingAuth;

  // The OpenAI SDK appends API paths (e.g. /responses, /chat/completions)
  // to baseUrl, so include /v1 to match the buyer proxy's expected paths.
  const needsV1 = protocol === 'openai-responses' || protocol === 'openai-chat-completions';
  const base = {
    id: serviceId,
    name: serviceId,
    provider: PROXY_PROVIDER_ID,
    baseUrl: needsV1 ? `http://127.0.0.1:${port}/v1` : `http://127.0.0.1:${port}`,
    reasoning: true,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    headers,
  };

  if (protocol === 'openai-chat-completions') {
    return {
      ...base,
      api: 'openai-completions' as const,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: 'max_tokens' as const,
        supportsStrictMode: false,
      },
    };
  }

  if (protocol === 'openai-responses') {
    return {
      ...base,
      api: 'openai-responses' as const,
    };
  }

  return { ...base, api: 'anthropic-messages' as const };
}

function convertUserMessageForUi(message: Message): AiChatMessage {
  return {
    role: 'user',
    content: convertPiMessageToUiBlocks(message),
    createdAt: normalizeTokenCount((message as { timestamp?: number }).timestamp),
  };
}

function convertAssistantMessageForUi(
  message: AssistantMessage & { meta?: AiMessageMeta },
): AiChatMessage {
  const usage = ensureUsageShape(message.usage);
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  const usageMeta: AiMessageMeta = {
    provider: message.provider,
    service: message.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    tokenSource: usage.input > 0 || usage.output > 0 ? 'usage' : 'unknown',
  };
  const mergedMeta: AiMessageMeta = {
    ...usageMeta,
    ...(message.meta ?? {}),
  };
  return {
    role: 'assistant',
    content: convertPiMessageToUiBlocks(message),
    createdAt: normalizeTokenCount(message.timestamp),
    meta: mergedMeta,
  };
}

function mergeAssistantMessagesForUi(base: AiChatMessage | null, next: AiChatMessage): AiChatMessage {
  const toBlocks = (content: AiChatMessage['content']): ContentBlock[] => {
    if (Array.isArray(content)) {
      return content.map((block) => ({ ...block }));
    }
    const text = String(content ?? '');
    return text.length > 0 ? [{ type: 'text', text }] : [];
  };

  if (!base) {
    return next;
  }
  const baseContent = toBlocks(base.content);
  const nextContent = toBlocks(next.content);
  return {
    ...base,
    ...next,
    createdAt: base.createdAt || next.createdAt,
    meta: {
      ...(base.meta ?? {}),
      ...(next.meta ?? {}),
    },
    content: [...baseContent, ...nextContent],
  };
}

async function isPortReachable(port: number, timeoutMs = 700): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Math.floor(port) });

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function resolveProxyPort(configPath: string): Promise<number> {
  try {
    const raw = await stat(configPath);
    if (!raw.isFile()) {
      return DEFAULT_PROXY_PORT;
    }
  } catch {
    return DEFAULT_PROXY_PORT;
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      buyer?: { proxyPort?: unknown };
    };
    const configured = Number(parsed.buyer?.proxyPort);
    if (Number.isFinite(configured) && configured > 0 && configured <= 65535) {
      return Math.floor(configured);
    }
  } catch {
    return DEFAULT_PROXY_PORT;
  }

  return DEFAULT_PROXY_PORT;
}

function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveSystemPrompt(configPath: string): Promise<string | undefined> {
  const fromEnv = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_ENV]);
  if (fromEnv) {
    return fromEnv;
  }

  const promptPath = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_FILE_ENV]);
  if (promptPath) {
    try {
      const fileText = await readFile(path.resolve(promptPath), 'utf8');
      const normalized = normalizePromptText(fileText);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Ignore invalid prompt files and continue to config fallback.
    }
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      buyer?: { chatSystemPrompt?: unknown };
    };
    return normalizePromptText(parsed.buyer?.chatSystemPrompt);
  } catch {
    return undefined;
  }
}

function extractToolCallFromPartial(
  partial: AssistantMessage,
  contentIndex: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const block = partial.content[contentIndex];
  if (!block || block.type !== 'toolCall') {
    return {
      id: `tool-${String(contentIndex)}`,
      name: 'tool',
      arguments: {},
    };
  }
  return {
    id: block.id || `tool-${String(contentIndex)}`,
    name: block.name || 'tool',
    arguments: (block.arguments ?? {}) as Record<string, unknown>,
  };
}

class PiConversationStore {
  private readonly sessionsDir = CHAT_SESSIONS_DIR;
  private readonly ready: Promise<void>;
  private readonly pathCache = new Map<string, string>();
  private readonly pendingManagers = new Map<string, SessionManager>();

  constructor() {
    this.ready = this.ensureDirs();
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(CHAT_AGENT_DIR, { recursive: true });
  }

  private async ensureWorkspaceDir(): Promise<string> {
    await this.ready;
    const workspaceDir = getCurrentChatWorkspaceDir();
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async listSessionPaths(): Promise<SessionPathInfo[]> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const sessions = await SessionManager.list(workspaceDir, this.sessionsDir);
    const infos = sessions.map((entry) => ({ id: entry.id, path: entry.path }));
    this.pathCache.clear();
    for (const info of infos) {
      this.pathCache.set(info.id, info.path);
    }
    return infos;
  }

  private async buildConversationFromManager(manager: SessionManager): Promise<AiConversation> {
    const context = manager.buildSessionContext();
    const messages = convertPiMessagesToUi(context.messages as Message[]);
    const usage = deriveUsage(messages);
    const header = manager.getHeader();
    const createdAtRaw = header ? Date.parse(header.timestamp) : Date.now();
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now();
    const latestMessageAt = messages.reduce((max, message) => {
      const ts = normalizeTokenCount(message.createdAt);
      return ts > max ? ts : max;
    }, 0);

    let updatedAt = Math.max(createdAt, latestMessageAt);
    const sessionPath = manager.getSessionFile();
    if (sessionPath && existsSync(sessionPath)) {
      try {
        const fileStat = await stat(sessionPath);
        updatedAt = Math.max(updatedAt, Math.floor(fileStat.mtimeMs));
      } catch {
        // Keep the computed updatedAt when stat fails.
      }
    } else {
      updatedAt = Math.max(updatedAt, Date.now());
    }

    return {
      id: manager.getSessionId(),
      title: manager.getSessionName() || deriveTitle(messages),
      service: normalizeServiceId(context.model?.modelId),
      provider: normalizeProviderId(context.model?.provider) ?? undefined,
      messages,
      createdAt,
      updatedAt,
      usage,
    };
  }

  private async resolvePath(id: string): Promise<string | null> {
    await this.ready;
    const cached = this.pathCache.get(id);
    if (cached && existsSync(cached)) {
      return cached;
    }
    const all = await this.listSessionPaths();
    const found = all.find((entry) => entry.id === id);
    return found?.path ?? null;
  }

  private async readConversationFromPath(sessionPath: string): Promise<AiConversation | null> {
    try {
      const manager = SessionManager.open(sessionPath, this.sessionsDir);
      return await this.buildConversationFromManager(manager);
    } catch {
      return null;
    }
  }

  async list(): Promise<AiConversationSummary[]> {
    const sessionPaths = await this.listSessionPaths();
    const summaryById = new Map<string, AiConversationSummary>();
    for (const info of sessionPaths) {
      const conversation = await this.readConversationFromPath(info.path);
      if (!conversation) {
        continue;
      }
      const totalTokens = normalizeTokenCount(conversation.usage.inputTokens) + normalizeTokenCount(conversation.usage.outputTokens);
      summaryById.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        service: conversation.service,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
      });
    }

    for (const [conversationId, manager] of this.pendingManagers.entries()) {
      if (summaryById.has(conversationId)) {
        continue;
      }
      const conversation = await this.buildConversationFromManager(manager);
      const totalTokens = normalizeTokenCount(conversation.usage.inputTokens) + normalizeTokenCount(conversation.usage.outputTokens);
      summaryById.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        service: conversation.service,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
      });
    }

    return [...summaryById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(id: string): Promise<AiConversation | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return await this.buildConversationFromManager(pending);
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return await this.readConversationFromPath(sessionPath);
  }

  async create(service?: string, provider?: string): Promise<AiConversation> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const manager = SessionManager.create(workspaceDir, this.sessionsDir);
    const providerId = normalizeProviderId(provider);
    const modelProvider = providerId && inferProviderProtocol(providerId) ? providerId : PROXY_PROVIDER_ID;
    manager.appendModelChange(modelProvider, normalizeServiceId(service));
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) {
      throw new Error('Failed to create persisted pi session');
    }
    const conversation = await this.buildConversationFromManager(manager);
    this.pendingManagers.set(conversation.id, manager);
    this.pathCache.set(conversation.id, sessionPath);
    return conversation;
  }

  async delete(id: string): Promise<void> {
    const pending = this.pendingManagers.get(id);
    const pendingPath = pending?.getSessionFile() ?? null;
    this.pendingManagers.delete(id);

    const sessionPath = (await this.resolvePath(id)) ?? pendingPath;
    if (!sessionPath) {
      this.pathCache.delete(id);
      return;
    }
    try {
      await unlink(sessionPath);
    } catch {
      // Session may already be deleted.
    }
    this.pathCache.delete(id);
  }

  async openSessionManager(id: string): Promise<SessionManager | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return pending;
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return SessionManager.open(sessionPath, this.sessionsDir);
  }

  markPersistedIfAvailable(id: string): void {
    const pending = this.pendingManagers.get(id);
    if (!pending) {
      return;
    }
    const sessionPath = pending.getSessionFile();
    if (!sessionPath) {
      return;
    }
    if (!existsSync(sessionPath)) {
      return;
    }
    this.pendingManagers.delete(id);
    this.pathCache.set(id, sessionPath);
  }
}

function toToolOutputString(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const result = value as { content?: Array<{ type?: string; text?: string; mimeType?: string }> };
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(String(block.text ?? ''));
    } else {
      parts.push(`[image:${String(block.mimeType ?? 'unknown')}]`);
    }
  }
  return parts.join('\n').trim();
}

function parseAssistantMetaFromSessionEvent(
  assistant: AssistantMessage,
  proxyMeta: AiMessageMeta | undefined,
): AiMessageMeta {
  const usage = ensureUsageShape(assistant.usage);
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  const usageMeta: AiMessageMeta = {
    provider: assistant.provider,
    service: assistant.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    tokenSource: usage.input > 0 || usage.output > 0 ? 'usage' : 'unknown',
    estimatedCostUsd: usage.cost.total > 0 ? usage.cost.total : undefined,
  };
  const merged: AiMessageMeta = {
    ...usageMeta,
    ...(proxyMeta ?? {}),
  };
  if (!merged.tokenSource || merged.tokenSource === 'unknown') {
    merged.tokenSource = usageMeta.tokenSource;
  }
  if (!merged.totalTokens || merged.totalTokens <= 0) {
    merged.totalTokens = totalTokens;
  }
  if (!merged.inputTokens || merged.inputTokens <= 0) {
    merged.inputTokens = usage.input;
  }
  if (!merged.outputTokens || merged.outputTokens <= 0) {
    merged.outputTokens = usage.output;
  }
  return merged;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : 'Unexpected error';
}

function toConversationTitle(userMessage: string): string {
  const normalized = userMessage.trim();
  if (normalized.length === 0) {
    return 'New conversation';
  }
  return normalized.slice(0, 60) + (normalized.length > 60 ? '...' : '');
}

export function registerPiChatHandlers({
  ipcMain,
  sendToRenderer,
  configPath,
  isBuyerRuntimeRunning,
  ensureBuyerRuntimeStarted,
  appendSystemLog,
  getNetworkPeers,
}: RegisterPiChatHandlersOptions): {
  setPendingSpendingAuth: (conversationId: string, authBase64: string) => void;
  getCachedPaymentRequired: (conversationId: string) => Record<string, unknown> | null;
} {
  void loadChatWorkspaceDir().catch(() => {});
  const store = new PiConversationStore();
  const activeRunsByConversation = new Map<string, ActiveRun>();
  const serviceProviderHints = new Map<string, string[]>();
  /** Pending signed SpendingAuth to inject as header on the next request for a conversation. */
  const pendingSpendingAuth = new Map<string, string>();
  /** Cached payment-required info from 402 responses, keyed by conversationId. */
  const cachedPaymentRequired = new Map<string, Record<string, unknown>>();
  const serviceProtocolMap = new Map<string, ChatServiceProtocol>();
  const preferredPeerByConversationId = new Map<string, string>();

  const cacheFallbackPaymentRequired = (conversationId: string, suggestedAmount: string): void => {
    const peerId = preferredPeerByConversationId.get(conversationId) ?? null;
    if (!peerId) {
      return;
    }
    const existing = cachedPaymentRequired.get(conversationId) ?? {};
    cachedPaymentRequired.set(conversationId, {
      ...existing,
      peerId,
      suggestedAmount,
    });
  };

  const clearActiveRun = (run: ActiveRun | null): void => {
    if (!run) {
      return;
    }

    try {
      run.unsubscribe();
    } catch {
      // Ignore listener cleanup failures.
    }

    try {
      run.session.dispose();
    } catch {
      // Ignore disposal races.
    }

    if (activeRunsByConversation.get(run.conversationId) === run) {
      activeRunsByConversation.delete(run.conversationId);
    }
  };

  const abortAndClearActiveRun = async (run: ActiveRun | null): Promise<void> => {
    if (!run) {
      return;
    }

    try {
      await run.session.abort();
    } catch {
      // Ignore abort races.
    }

    clearActiveRun(run);
  };

  const isProxyAvailable = async (port: number): Promise<boolean> => {
    return await isPortReachable(port);
  };

  const waitForBuyerProxy = async (port: number, timeoutMs = 20_000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await isProxyAvailable(port)) {
          return true;
        }
      } catch {
        // transient error — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  const runStreamingPrompt = async (
    conversationId: string,
    userMessage: string,
    serviceOverride?: string,
    providerOverride?: string,
    imageBase64?: string,
    imageMimeType?: string,
    permissionModeValue?: ChatPermissionMode,
  ): Promise<{ ok: boolean; error?: string }> => {
    const trimmedMessage = userMessage.trim();
    if (trimmedMessage.length === 0 && !imageBase64) {
      return { ok: false, error: 'Empty message' };
    }

    const existingRun = activeRunsByConversation.get(conversationId);
    if (existingRun) {
      appendSystemLog(
        `Cancelling existing in-flight chat request for conversation ${existingRun.conversationId.slice(0, 8)}...`,
      );
      await abortAndClearActiveRun(existingRun);
    }

    const proxyPort = await resolveProxyPort(configPath);
    const runtimeRunning = isBuyerRuntimeRunning();
    let proxyAvailable = await isProxyAvailable(proxyPort);
    if (!proxyAvailable && ensureBuyerRuntimeStarted) {
      if (runtimeRunning) {
        appendSystemLog(`Buyer runtime is running. Waiting for proxy :${proxyPort}...`);
      } else {
        appendSystemLog(`Buyer proxy offline on port ${proxyPort}; attempting to start Buyer runtime...`);
      }
      try {
        const started = runtimeRunning ? true : await ensureBuyerRuntimeStarted();
        if (started) {
          if (!runtimeRunning) {
            appendSystemLog(`Buyer runtime start requested. Waiting for proxy :${proxyPort}...`);
          }
          proxyAvailable = await waitForBuyerProxy(proxyPort);
        }
      } catch (error) {
        appendSystemLog(`Buyer runtime auto-start failed: ${asErrorMessage(error)}`);
      }
    }
    if (!proxyAvailable) {
      return {
        ok: false,
        error: `Buyer proxy is not reachable on port ${proxyPort}. Start Buyer runtime or fix buyer.proxyPort in config.`,
      };
    }

    const sessionManager = await store.openSessionManager(conversationId);
    if (!sessionManager) {
      return { ok: false, error: 'Conversation not found' };
    }

    const context = sessionManager.buildSessionContext();

    const serviceId = normalizeServiceId(serviceOverride || context.model?.modelId);
    const permissionMode = normalizeChatPermissionMode(permissionModeValue);
    const preferredPeerId = preferredPeerByConversationId.get(conversationId) ?? null;
    const providerHint = resolveProviderHintForService(
      providerOverride,
    );
    const protocol = await resolveProtocolForSend(serviceId);
    // Inject pending spending auth header if the user approved a payment for this conversation
    const spendingAuth = pendingSpendingAuth.get(conversationId) ?? null;
    if (spendingAuth) pendingSpendingAuth.delete(conversationId);
    const proxyModel = makeProxyService(serviceId, proxyPort, protocol, providerHint, preferredPeerId, spendingAuth);

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROXY_PROVIDER_ID, PROXY_RUNTIME_API_KEY);
    const modelRegistry = new ModelRegistry(authStorage);

    // Pass the system prompt via resourceLoader so it is applied on every turn.
    // (agent-session rebuilds _baseSystemPrompt from the loader each turn, so a
    // one-shot session.agent.setSystemPrompt call would be overridden.)
    // Priority: user override (env/config) → AntStation default.
    const userSystemPrompt = await resolveSystemPrompt(configPath);
    const chatWorkspaceDir = getCurrentChatWorkspaceDir();
    const settingsManager = SettingsManager.create(chatWorkspaceDir, CHAT_AGENT_DIR);
    const resourceLoader = new DefaultResourceLoader({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      settingsManager,
      systemPrompt: userSystemPrompt ?? ANTSTATION_SYSTEM_PROMPT,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      sessionManager,
      authStorage,
      modelRegistry,
      model: proxyModel,
      customTools: [webFetchTool, createBrowserPreviewTool(sendToRenderer), startDevServerTool],
      resourceLoader,
    });

    await session.setModel(proxyModel);
    session.setActiveToolsByName(resolveChatActiveToolNames(permissionMode));
    session.agent.sessionId = conversationId;

    const existingUserMessages = session.messages.filter((message) => message.role === 'user').length;
    if (existingUserMessages === 0 && (!session.sessionName || session.sessionName.trim().length === 0)) {
      session.setSessionName(toConversationTitle(trimmedMessage));
    }

    const turnMetaQueue: AiMessageMeta[] = [];
    const toolArgsById = new Map<string, Record<string, unknown>>();
    // Pi's native streaming handles all API formats (anthropic-messages,
    // openai-completions, openai-responses) via model.api + model.baseUrl.
    // No custom streamFn needed — the buyer proxy at model.baseUrl is a
    // transparent HTTP proxy that speaks the same API as the upstream provider.

    let turnIndex = 0;
    let userPersisted = false;
    let streamDone = false;
    let pendingAssistantMessage: AiChatMessage | null = null;

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'turn_start') {
        sendToRenderer('chat:ai-stream-start', { conversationId, turn: turnIndex });
        turnIndex += 1;
        return;
      }

      if (event.type === 'message_update') {
        const message = event.message as Message;
        if (message.role !== 'assistant') {
          return;
        }
        const update = event.assistantMessageEvent as AssistantMessageEvent;
        if (update.type === 'text_start') {
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
          });
          return;
        }
        if (update.type === 'text_delta') {
          sendToRenderer('chat:ai-stream-delta', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
            text: update.delta,
          });
          return;
        }
        if (update.type === 'text_end') {
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
          });
          return;
        }
        if (update.type === 'thinking_start') {
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
          });
          return;
        }
        if (update.type === 'thinking_delta') {
          sendToRenderer('chat:ai-stream-delta', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
            text: update.delta,
          });
          return;
        }
        if (update.type === 'thinking_end') {
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
          });
          return;
        }
        if (update.type === 'toolcall_start') {
          const tool = extractToolCallFromPartial(update.partial, update.contentIndex);
          if (isToolArgumentsObject(tool.arguments)) {
            toolArgsById.set(tool.id, tool.arguments);
          }
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'tool_use',
            toolId: tool.id,
            toolName: tool.name,
          });
          return;
        }
        if (update.type === 'toolcall_end') {
          const toolInput = isToolArgumentsObject(update.toolCall.arguments)
            ? update.toolCall.arguments
            : {};
          toolArgsById.set(update.toolCall.id, toolInput);
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'tool_use',
            toolId: update.toolCall.id,
            toolName: update.toolCall.name,
            input: toolInput,
          });
        }
        return;
      }

      if (event.type === 'tool_execution_start') {
        const eventArgs = isToolArgumentsObject(event.args) ? event.args : undefined;
        if (eventArgs) {
          toolArgsById.set(event.toolCallId, eventArgs);
        }
        sendToRenderer('chat:ai-tool-executing', {
          conversationId,
          toolUseId: event.toolCallId,
          name: event.toolName,
          input: eventArgs ?? toolArgsById.get(event.toolCallId) ?? {},
        });
        return;
      }

      if (event.type === 'tool_execution_update') {
        const eventArgs = isToolArgumentsObject(event.args) ? event.args : undefined;
        sendToRenderer('chat:ai-tool-update', {
          conversationId,
          toolUseId: event.toolCallId,
          name: event.toolName,
          input: eventArgs ?? toolArgsById.get(event.toolCallId) ?? {},
          output: toToolOutputString(event.partialResult),
          details:
            event.partialResult &&
            typeof event.partialResult === 'object' &&
            'details' in event.partialResult &&
            event.partialResult.details &&
            typeof event.partialResult.details === 'object'
              ? (event.partialResult.details as Record<string, unknown>)
              : undefined,
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        toolArgsById.delete(event.toolCallId);
        sendToRenderer('chat:ai-tool-result', {
          conversationId,
          toolUseId: event.toolCallId,
          output: toToolOutputString(event.result),
          isError: Boolean(event.isError),
          details:
            event.result &&
            typeof event.result === 'object' &&
            'details' in event.result &&
            event.result.details &&
            typeof event.result.details === 'object'
              ? (event.result.details as Record<string, unknown>)
              : undefined,
        });
        return;
      }

      if (event.type === 'message_end') {
        const message = event.message as Message | (AssistantMessage & { meta?: AiMessageMeta });
        if (message.role === 'user' && !userPersisted) {
          userPersisted = true;
          sendToRenderer('chat:ai-user-persisted', {
            conversationId,
            message: convertUserMessageForUi(message),
          });
          return;
        }
        if (message.role === 'assistant') {
          // Detect payment errors from the provider's 402 JSON response
          const msgAny = message as unknown as Record<string, unknown>;
          const errorMsg = typeof msgAny.errorMessage === 'string' ? msgAny.errorMessage : '';
          const rawContent = Array.isArray(msgAny.content)
            ? (msgAny.content as Array<Record<string, unknown>>).map((b) => String(b.text ?? '')).join('')
            : String(msgAny.content ?? '');

          // Check errorMessage first (Pi agent may put "402 {"error":"payment_required",...}" there)
          if (/402.*payment_required|payment_required/i.test(errorMsg) || /402.*payment_required|payment_required/i.test(rawContent)) {
            // Try to parse the full payment body from content, errorMessage, or embedded JSON
            let paymentBody: Record<string, unknown> | null = null;
            try { paymentBody = JSON.parse(rawContent) as Record<string, unknown>; } catch { /* not JSON */ }
            if (!paymentBody || !paymentBody.sellerEvmAddr) {
              try { paymentBody = JSON.parse(errorMsg) as Record<string, unknown>; } catch { /* not JSON */ }
            }
            // SDK wraps the body as "402 {json}" — extract the embedded JSON
            if (!paymentBody || !paymentBody.sellerEvmAddr) {
              const jsonStart = errorMsg.indexOf('{');
              if (jsonStart >= 0) {
                try { paymentBody = JSON.parse(errorMsg.slice(jsonStart)) as Record<string, unknown>; } catch { /* not JSON */ }
              }
            }
            const suggestedAmount = typeof paymentBody?.suggestedAmount === 'string'
              ? paymentBody.suggestedAmount : '100000';
            if (paymentBody?.sellerEvmAddr) {
              cachedPaymentRequired.set(conversationId, paymentBody);
            } else {
              cacheFallbackPaymentRequired(conversationId, suggestedAmount);
            }
            sendToRenderer('chat:ai-stream-error', {
              conversationId,
              error: `payment_required:${suggestedAmount}`,
            });
            const activeRun = activeRunsByConversation.get(conversationId);
            if (activeRun) void abortAndClearActiveRun(activeRun);
            return;
          }

          // Also check if the response body itself is a payment_required JSON
          let paymentBody: Record<string, unknown> | null = null;
          try { paymentBody = JSON.parse(rawContent) as Record<string, unknown>; } catch { /* not JSON */ }
          if (paymentBody?.error === 'payment_required') {
            const suggestedAmount = typeof paymentBody.suggestedAmount === 'string'
              ? paymentBody.suggestedAmount : '100000';
            // Cache payment info so the approve IPC handler can build the SpendingAuth
            cachedPaymentRequired.set(conversationId, paymentBody);
            sendToRenderer('chat:ai-stream-error', {
              conversationId,
              error: `payment_required:${suggestedAmount}`,
            });
            const activeRun = activeRunsByConversation.get(conversationId);
            if (activeRun) void abortAndClearActiveRun(activeRun);
            return;
          }

          const proxyMeta = turnMetaQueue.shift();
          const parsedMeta = parseAssistantMetaFromSessionEvent(message, proxyMeta);
          const peerId = normalizePeerId(parsedMeta.peerId);
          if (peerId) {
            preferredPeerByConversationId.set(conversationId, peerId);
          }
          const assistantMessage = message as AssistantMessage & { meta?: AiMessageMeta };
          assistantMessage.meta = parsedMeta;
          pendingAssistantMessage = mergeAssistantMessagesForUi(
            pendingAssistantMessage,
            convertAssistantMessageForUi(assistantMessage),
          );
        }
        return;
      }

      if (event.type === 'agent_end') {
        // Don't finalize here — auto-retry may follow with a new agent_start.
        // The post-session.prompt code handles final chat:ai-done / chat:ai-stream-done.
      }
    });

    const run: ActiveRun = { conversationId, session, unsubscribe };
    activeRunsByConversation.set(conversationId, run);

    try {
      const images: ImageContent[] = imageBase64 && imageMimeType
        ? [{ type: 'image', data: imageBase64, mimeType: imageMimeType }]
        : [];
      await session.prompt(trimmedMessage || ' ', { images: images.length > 0 ? images : undefined });

      // Check if the agent received a 402 payment_required response.
      // The node returns JSON with "error":"payment_required" which the agent
      // treats as a completed turn with empty/error content.
      if (pendingAssistantMessage) {
        const lastMsg = pendingAssistantMessage as AiChatMessage;
        const c = lastMsg.content;
        const lastText = typeof c === 'string' ? c : Array.isArray(c)
          ? c.map((b) => typeof b === 'object' && b !== null && 'text' in b ? String(b.text) : '').join('')
          : '';
        let payBody: Record<string, unknown> | null = null;
        try { payBody = JSON.parse(lastText) as Record<string, unknown>; } catch { /* not JSON */ }
        if (payBody?.error === 'payment_required') {
          const amt = typeof payBody.suggestedAmount === 'string' ? payBody.suggestedAmount : '100000';
          if (payBody.sellerEvmAddr) {
            cachedPaymentRequired.set(conversationId, payBody);
          } else {
            cacheFallbackPaymentRequired(conversationId, amt);
          }
          pendingAssistantMessage = null;
          sendToRenderer('chat:ai-stream-error', {
            conversationId,
            error: `payment_required:${amt}`,
          });
          return { ok: false, error: 'Payment required' };
        }
      }

      if (pendingAssistantMessage) {
        sendToRenderer('chat:ai-done', {
          conversationId,
          message: pendingAssistantMessage,
        });
        pendingAssistantMessage = null;
      }
      if (!streamDone) {
        streamDone = true;
        sendToRenderer('chat:ai-stream-done', { conversationId });
      }
      return { ok: true };
    } catch (error) {
      // Always discard any buffered assistant message on error — it will not be committed.
      pendingAssistantMessage = null;
      if ((error as Error).name === 'AbortError') {
        sendToRenderer('chat:ai-stream-error', { conversationId, error: 'Request aborted' });
        return { ok: false, error: 'Aborted' };
      }
      const message = asErrorMessage(error);
      // Map insufficient balance / 402 errors to payment_required format
      // so the renderer shows the Add Credits card
      const isPaymentError = /insufficient.*balance|escrow.*balance|402.*payment/i.test(message);
      if (isPaymentError) {
        // Try to extract the payment_required JSON from the error message (SDK wraps it as "402 {json}")
        let payBody: Record<string, unknown> | null = null;
        const jsonStart = message.indexOf('{');
        if (jsonStart >= 0) {
          try { payBody = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>; } catch { /* not JSON */ }
        }
        if (payBody?.sellerEvmAddr) {
          cachedPaymentRequired.set(conversationId, payBody);
        }
        const amt = typeof payBody?.suggestedAmount === 'string' ? payBody.suggestedAmount : '0';
        if (!payBody?.sellerEvmAddr && amt !== '0') {
          cacheFallbackPaymentRequired(conversationId, amt);
        }
        sendToRenderer('chat:ai-stream-error', { conversationId, error: `payment_required:${amt}` });
      } else {
        sendToRenderer('chat:ai-stream-error', { conversationId, error: message });
      }
      appendSystemLog(`Pi chat error: ${message}`);
      return { ok: false, error: message };
    } finally {
      clearActiveRun(run);
      store.markPersistedIfAvailable(conversationId);
    }
  };

  let lastServiceCatalogEntries: ChatServiceCatalogEntry[] = [];
  let lastServiceCatalogRefreshAt = 0;
  const SERVICE_CATALOG_DEBOUNCE_MS = 5_000;
  let serviceCatalogRefreshPromise: Promise<ChatServiceCatalogEntry[]> | null = null;

  const refreshServiceCatalogFromNetwork = async (): Promise<ChatServiceCatalogEntry[]> => {
    // Deduplicate concurrent calls
    if (serviceCatalogRefreshPromise) return serviceCatalogRefreshPromise;
    // Debounce rapid calls (e.g. UI refreshes)
    if (Date.now() - lastServiceCatalogRefreshAt < SERVICE_CATALOG_DEBOUNCE_MS && lastServiceCatalogEntries.length > 0) {
      return lastServiceCatalogEntries;
    }

    serviceCatalogRefreshPromise = (async () => {
      const entries = await discoverChatServiceCatalog(getNetworkPeers);
      const limited = limitChatServiceCatalogEntries(normalizeChatServiceCatalogEntries(entries));
      updateServiceProviderHints(serviceProviderHints, limited);
      updateServiceProtocolMap(serviceProtocolMap, limited);
      lastServiceCatalogRefreshAt = Date.now();
      lastServiceCatalogEntries = limited;
      return limited;
    })().finally(() => { serviceCatalogRefreshPromise = null; });

    return serviceCatalogRefreshPromise;
  };

  const resolveProtocolForSend = async (serviceId: string): Promise<ChatServiceProtocol> => {
    const normalizedServiceId = serviceId.trim().toLowerCase();
    const existing = serviceProtocolMap.get(normalizedServiceId);
    if (existing) {
      return existing;
    }

    const refreshed = await refreshServiceCatalogFromNetwork();
    return refreshed.find((entry) => entry.id.trim().toLowerCase() === normalizedServiceId)?.protocol ?? 'anthropic-messages';
  };

  ipcMain.handle('chat:ai-get-proxy-status', async () => {
    const port = await resolveProxyPort(configPath);
    const running = await isProxyAvailable(port);
    return {
      ok: true,
      data: {
        running,
        port,
      },
    };
  });

  ipcMain.handle('chat:ai-list-services', async () => {
    try {
      const entries = await refreshServiceCatalogFromNetwork();
      return { ok: true, data: entries };
    } catch (error) {
      return { ok: false, data: [] as ChatServiceCatalogEntry[], error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-list-conversations', async () => {
    const conversations = await store.list();
    return { ok: true, data: conversations };
  });

  ipcMain.handle('chat:ai-get-workspace', async () => {
    const workspaceDir = await loadChatWorkspaceDir();
    return {
      ok: true,
      data: {
        current: workspaceDir,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-workspace-git-status', async () => {
    try {
      const workspaceDir = await loadChatWorkspaceDir();
      return {
        ok: true,
        data: await getWorkspaceGitStatus(workspaceDir),
      };
    } catch (error) {
      return {
        ok: false,
        error: asErrorMessage(error),
      };
    }
  });

  ipcMain.handle('chat:ai-set-workspace', async (_event, workspaceDir: string) => {
    const current = await persistChatWorkspaceDir(workspaceDir);
    return {
      ok: true,
      data: {
        current,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
    const conversation = await store.get(id);
    if (!conversation) {
      return { ok: false, error: 'Conversation not found' };
    }
    return { ok: true, data: conversation };
  });

  ipcMain.handle('chat:ai-create-conversation', async (_event, service: string, provider?: string, peerId?: string) => {
    const conversation = await store.create(service, provider);
    if (peerId && peerId.trim().length > 0) {
      preferredPeerByConversationId.set(conversation.id, peerId.trim());
    } else {
      preferredPeerByConversationId.delete(conversation.id);
    }
    return { ok: true, data: conversation };
  });

  ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
    preferredPeerByConversationId.delete(id);
    cachedPaymentRequired.delete(id);
    pendingSpendingAuth.delete(id);
    await store.delete(id);
    return { ok: true };
  });

  ipcMain.handle('chat:ai-rename-conversation', async (_event, id: string, title: string) => {
    const manager = await store.openSessionManager(id);
    if (!manager) {
      return { ok: false, error: 'Conversation not found' };
    }
    manager.appendSessionInfo(title.trim());
    return { ok: true };
  });

  ipcMain.handle(
    'chat:ai-send-stream',
    async (_event, conversationId: string, userMessage: string, service?: string, provider?: string, imageBase64?: string, imageMimeType?: string, permissionMode?: ChatPermissionMode) => {
      return await runStreamingPrompt(conversationId, userMessage, service, provider, imageBase64, imageMimeType, permissionMode);
    },
  );

  ipcMain.handle(
    'chat:ai-send',
    async (_event, conversationId: string, userMessage: string, service?: string, provider?: string, imageBase64?: string, imageMimeType?: string, permissionMode?: ChatPermissionMode) => {
      return await runStreamingPrompt(conversationId, userMessage, service, provider, imageBase64, imageMimeType, permissionMode);
    },
  );

  ipcMain.handle('chat:ai-abort', async () => {
    const activeRuns = Array.from(activeRunsByConversation.values());
    if (activeRuns.length === 0) {
      return { ok: true };
    }
    await Promise.all(activeRuns.map((run) => abortAndClearActiveRun(run)));
    return { ok: true };
  });

  ipcMain.handle('chat:ai-select-peer', async (_event, peerId: string | null) => {
    const normalizedPeerId = peerId && peerId.trim().length > 0 ? peerId.trim() : null;
    if (!normalizedPeerId) {
      preferredPeerByConversationId.clear();
      return { ok: true };
    }
    // Eager connection warmup via buyer proxy
    const proxyPort = await resolveProxyPort(configPath);
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/_antseed/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerId: normalizedPeerId }),
      });
      const result = await response.json() as { ok: boolean; error?: string };
      return { ok: result.ok, error: result.error };
    } catch (err) {
      return { ok: false, error: asErrorMessage(err) };
    }
  });

  return {
    setPendingSpendingAuth: (conversationId: string, authBase64: string) => {
      pendingSpendingAuth.set(conversationId, authBase64);
    },
    getCachedPaymentRequired: (conversationId: string) => {
      return cachedPaymentRequired.get(conversationId) ?? null;
    },
  };
}
