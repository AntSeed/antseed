import { type Static, Type } from '@sinclair/typebox';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

const BrowserPreviewParams = Type.Object({
  url: Type.String({
    description: 'The URL to open in the browser preview panel (e.g. http://localhost:3000).',
  }),
});

export function createBrowserPreviewTool(
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

export const startDevServerTool: ToolDefinition = {
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

    const child = spawn('bash', ['-c', command], {
      cwd,
      detached: true, // new process group — immune to parent signals
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    });

    // Unref so the Electron process can exit even if the dev server is still running
    child.unref();

    const collectOutput = (chunk: Buffer) => {
      output += chunk.toString();
      // Cap collected output to avoid unbounded memory
      if (output.length > 32_000) output = output.slice(-16_000);
    };

    child.stdout?.on('data', collectOutput);
    child.stderr?.on('data', collectOutput);

    const killFn = () => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* ignore */ }
    };

    runningDevServers.set(cwd, { pid: child.pid!, kill: killFn });

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
