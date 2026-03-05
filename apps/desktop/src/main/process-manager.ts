import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeMode = 'connect' | 'dashboard';

export interface RuntimeProcessState {
  mode: RuntimeMode;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastError: string | null;
}

export interface StartOptions {
  mode: RuntimeMode;
  router?: string;
  dashboardPort?: number;
  configPath?: string;
  verbose?: boolean;
  env?: Record<string, string>;
}

export interface DaemonStateSnapshot {
  exists: boolean;
  state: Record<string, unknown> | null;
}

export interface CliCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_DASHBOARD_PORT = 3117;
const DEFAULT_CLI_COMMAND = 'antseed';
const CLI_COMMAND_ENV = 'ANTSEED_CLI_BIN';
const CLI_NODE_BIN_ENV = 'ANTSEED_NODE_BIN';
const LOCAL_CLI_BIN_RELATIVE = ['..', 'cli', 'dist', 'cli', 'index.js'] as const;
const RUNTIME_NATIVE_SCRIPT_RELATIVE = ['scripts', 'ensure-runtime-native-modules.mjs'] as const;
const RUNTIME_NATIVE_MARKER_FILE = '.runtime-native-meta.json';
const DEFAULT_CONFIG_PATH = join(homedir(), '.antseed', 'config.json');
const DESKTOP_DATA_ROOT = join(homedir(), '.antseed-desktop');
const DESKTOP_CONNECT_DATA_DIR = join(DESKTOP_DATA_ROOT, 'connect');
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function normalizeRouterIdentifier(value: string | undefined): string {
  const raw = (value ?? 'local').trim().toLowerCase();
  if (!raw) return 'local';

  if (
    raw === 'claude-code'
    || raw === '@antseed/router-local'
    || raw === 'antseed-router-local'
    || raw === 'antseed-router-claude-code'
  ) {
    return 'local';
  }

  return raw;
}

function resolveAlignedNodeFromMarker(): string | null {
  const markerCandidates = [
    resolve(process.cwd(), RUNTIME_NATIVE_MARKER_FILE),
    resolve(process.cwd(), 'desktop', RUNTIME_NATIVE_MARKER_FILE),
  ];

  for (const markerPath of markerCandidates) {
    if (!existsSync(markerPath)) {
      continue;
    }
    try {
      const raw = readFileSync(markerPath, 'utf8');
      const parsed = JSON.parse(raw) as { nodeExec?: unknown };
      const nodeExec = typeof parsed.nodeExec === 'string' ? parsed.nodeExec.trim() : '';
      if (nodeExec.length > 0 && existsSync(nodeExec)) {
        return nodeExec;
      }
    } catch {
      // Ignore malformed marker files and continue with normal candidate resolution.
    }
  }

  return null;
}

function resolveCliCommand(): string {
  const envCommand = process.env[CLI_COMMAND_ENV]?.trim();
  if (envCommand && envCommand.length > 0) {
    return envCommand;
  }

  const localCli = resolveLocalCliPath();
  if (existsSync(localCli)) {
    return localCli;
  }

  // Packaged app: CLI dist copied into Resources/cli-dist/ via extraResources
  if (typeof process.resourcesPath === 'string') {
    const bundledCli = join(process.resourcesPath, 'cli-dist', 'cli', 'index.js');
    if (existsSync(bundledCli)) {
      return bundledCli;
    }
  }

  return DEFAULT_CLI_COMMAND;
}

function resolveLocalCliPath(): string {
  const candidates = [
    // Desktop package cwd (apps/desktop).
    resolve(process.cwd(), ...LOCAL_CLI_BIN_RELATIVE),
    // Monorepo root cwd.
    resolve(process.cwd(), 'apps', 'cli', 'dist', 'cli', 'index.js'),
    // Built desktop main script directory (apps/desktop/dist/main).
    resolve(MODULE_DIR, '..', '..', '..', 'cli', 'dist', 'cli', 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

/**
 * Build NODE_PATH so that a child process spawned from the packaged app
 * can resolve modules from the unpacked node_modules directory.
 */
function resolveChildNodePath(): string {
  const paths: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    // electron-builder unpacks node_modules here when asarUnpack includes them
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    if (existsSync(unpacked)) {
      paths.push(unpacked);
    }
  }
  return paths.join(':');
}

function detectNodeArch(nodeBinary: string): string | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.arch'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

type SemverTuple = [major: number, minor: number, patch: number];

function parseSemverTag(raw: string): SemverTuple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a: SemverTuple, b: SemverTuple): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  return b[2] - a[2];
}

function resolveNodeBinary(targetArch: string): string {
  const alignedNode = resolveAlignedNodeFromMarker();
  if (alignedNode) {
    return alignedNode;
  }

  const envNode = process.env[CLI_NODE_BIN_ENV]?.trim();
  const candidates: string[] = [];
  if (envNode) {
    candidates.push(envNode);
  }

  const nvmBin = process.env['NVM_BIN']?.trim();
  if (nvmBin) {
    candidates.push(join(nvmBin, 'node'));
  }

  const nvmVersionsDir = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    try {
      const nvmVersions = readdirSync(nvmVersionsDir)
        .map((name) => ({ name, semver: parseSemverTag(name) }))
        .sort((left, right) => {
          if (left.semver && right.semver) {
            return compareSemverDesc(left.semver, right.semver);
          }
          if (left.semver) return -1;
          if (right.semver) return 1;
          return right.name.localeCompare(left.name);
        })
        .map((entry) => entry.name);
      for (const version of nvmVersions) {
        candidates.push(join(nvmVersionsDir, version, 'bin', 'node'));
      }
    } catch {
      // Ignore nvm lookup failures and continue with other candidates.
    }
  }

  candidates.push('/opt/homebrew/bin/node');
  candidates.push('/usr/local/bin/node');
  candidates.push('node');

  const tried = new Set<string>();
  let firstExisting: string | null = null;

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) {
      continue;
    }
    tried.add(candidate);
    if (candidate !== 'node' && !existsSync(candidate)) {
      continue;
    }
    if (!firstExisting) {
      firstExisting = candidate;
    }
    const arch = detectNodeArch(candidate);
    if (arch === targetArch) {
      return candidate;
    }
  }

  return firstExisting ?? 'node';
}

function resolveConfigPath(configPath?: string): string {
  if (!configPath || configPath.trim().length === 0) {
    return DEFAULT_CONFIG_PATH;
  }
  if (configPath.startsWith('~/')) {
    return join(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

type CliExecution = {
  executable: string;
  executableArgsPrefix: string[];
  useLocalCliScript: boolean;
  cliCommand: string;
};

function resolveCliExecution(): CliExecution {
  const cliCommand = resolveCliCommand();
  const localCliPath = resolveLocalCliPath();
  const useLocalCliScript = existsSync(localCliPath) && resolve(cliCommand) === localCliPath;
  const executable = useLocalCliScript ? resolveNodeBinary(process.arch) : cliCommand;
  const executableArgsPrefix = useLocalCliScript ? [localCliPath] : [];
  return {
    executable,
    executableArgsPrefix,
    useLocalCliScript,
    cliCommand,
  };
}

function resolveCommandArgs(opts: StartOptions): string[] {
  const args: string[] = [];

  if (opts.verbose) {
    args.push('--verbose');
  }

  const configPath = resolveConfigPath(opts.configPath);
  args.push('--config', configPath);

  switch (opts.mode) {
    case 'connect':
      args.push('--data-dir', DESKTOP_CONNECT_DATA_DIR);
      args.push('connect', '--router', normalizeRouterIdentifier(opts.router));
      break;
    case 'dashboard':
      args.push('dashboard', '--port', String(opts.dashboardPort ?? DEFAULT_DASHBOARD_PORT), '--no-open');
      break;
    default:
      throw new Error(`Unsupported runtime mode: ${String(opts.mode)}`);
  }

  return args;
}

export class ProcessManager {
  private readonly processes = new Map<RuntimeMode, ChildProcessWithoutNullStreams>();
  private runtimeNativeAligned = false;
  private runtimeNativeAlignmentPromise: Promise<void> | null = null;
  private readonly states = new Map<RuntimeMode, RuntimeProcessState>([
    ['connect', { mode: 'connect', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
    ['dashboard', { mode: 'dashboard', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
  ]);

  constructor(
    private readonly onLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void,
  ) {}

  getState(): RuntimeProcessState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  getDaemonStateSnapshot(): DaemonStateSnapshot {
    const stateFile = join(homedir(), '.antseed', 'daemon.state.json');
    if (!existsSync(stateFile)) {
      return { exists: false, state: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
      return { exists: true, state: parsed };
    } catch {
      return { exists: true, state: null };
    }
  }

  async start(opts: StartOptions): Promise<RuntimeProcessState> {
    const mode = opts.mode;
    if (this.processes.has(mode)) {
      throw new Error(`${mode} is already running`);
    }

    const cliExecution = resolveCliExecution();
    const args = resolveCommandArgs(opts);
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];
    await this.ensureRuntimeNativeModules(mode, executable, cliExecution.useLocalCliScript);
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (typeof key === 'string' && key.trim().length > 0) {
        childEnv[key] = String(value);
      }
    }
    delete childEnv['ELECTRON_RUN_AS_NODE'];
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `:${childEnv['NODE_PATH']}` : '');
    }

    const child = spawn(executable, executableArgs, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'pipe',
    });

    this.processes.set(mode, child);

    const state = this.states.get(mode)!;
    state.running = true;
    state.pid = child.pid ?? null;
    state.startedAt = Date.now();
    state.lastError = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.onLog(mode, 'stdout', line);
        }
      }
    });

    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.onLog(mode, 'stderr', line);
        }
      }
    });

    child.on('error', (err) => {
      state.lastError = err.message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        state.running = false;
        state.pid = null;
        this.processes.delete(mode);
        this.onLog(
          mode,
          'system',
          `CLI command "${cliExecution.cliCommand}" was not found. Install antseed on PATH or set ${CLI_COMMAND_ENV} to a valid executable path.`,
        );
        return;
      }
      this.onLog(mode, 'system', `Process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.processes.delete(mode);
      state.running = false;
      state.pid = null;
      state.lastExitCode = code;
      const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
      this.onLog(mode, 'system', `Process exited (${reason})`);
    });

    this.onLog(
      mode,
      'system',
      `Started ${mode} with "${executable}" (pid=${String(child.pid ?? 'unknown')})`,
    );
    return { ...state };
  }

  async runCliCommand(args: string[], mode: RuntimeMode = 'dashboard'): Promise<CliCommandResult> {
    const cliExecution = resolveCliExecution();
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];

    const childEnv = { ...process.env };
    delete childEnv['ELECTRON_RUN_AS_NODE'];
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `:${childEnv['NODE_PATH']}` : '');
    }

    this.onLog(mode, 'system', `Running command: ${executableArgs.join(' ')}`);

    return await new Promise<CliCommandResult>((resolveCommand, rejectCommand) => {
      const child = spawn(executable, executableArgs, {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutTail = '';
      let stderrTail = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        stdoutTail += chunk;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        stderrTail += chunk;
        const lines = stderrTail.split(/\r?\n/);
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          rejectCommand(
            new Error(
              `CLI command "${cliExecution.cliCommand}" was not found. Install antseed on PATH or set ${CLI_COMMAND_ENV} to a valid executable path.`,
            ),
          );
          return;
        }
        rejectCommand(new Error(`CLI command failed to start: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutTail.trim().length > 0) {
          this.onLog(mode, 'system', stdoutTail.trim());
        }
        if (stderrTail.trim().length > 0) {
          this.onLog(mode, 'system', stderrTail.trim());
        }

        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          const reason = signal ? `signal=${signal}` : `code=${String(exitCode)}`;
          const detail = stderr.trim() || stdout.trim();
          rejectCommand(
            new Error(
              detail.length > 0
                ? `Command failed (${reason}): ${detail}`
                : `Command failed (${reason})`,
            ),
          );
          return;
        }

        resolveCommand({ code: exitCode, stdout, stderr });
      });
    });
  }

  private async ensureRuntimeNativeModules(mode: RuntimeMode, executable: string, useLocalCliScript: boolean): Promise<void> {
    if (!useLocalCliScript) {
      return;
    }
    if (this.runtimeNativeAligned) {
      return;
    }
    if (this.runtimeNativeAlignmentPromise) {
      await this.runtimeNativeAlignmentPromise;
      return;
    }

    const scriptPath = resolve(process.cwd(), ...RUNTIME_NATIVE_SCRIPT_RELATIVE);
    if (!existsSync(scriptPath)) {
      this.onLog(mode, 'system', 'Native module preflight script not found; skipping runtime alignment.');
      return;
    }

    this.runtimeNativeAlignmentPromise = this.runRuntimeNativeAlignment(mode, executable, scriptPath)
      .then(() => {
        this.runtimeNativeAligned = true;
      })
      .catch((err) => {
        this.runtimeNativeAlignmentPromise = null;
        throw err;
      });

    await this.runtimeNativeAlignmentPromise;
  }

  private async runRuntimeNativeAlignment(mode: RuntimeMode, executable: string, scriptPath: string): Promise<void> {
    const childEnv = { ...process.env };
    delete childEnv['ELECTRON_RUN_AS_NODE'];

    await new Promise<void>((resolveAlignment, rejectAlignment) => {
      const child = spawn(executable, [scriptPath], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutTail = '';
      let stderrTail = '';
      let stderrCapture = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdoutTail += chunk;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderrTail += chunk;
        stderrCapture += chunk;
        const lines = stderrTail.split(/\r?\n/);
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.on('error', (err) => {
        rejectAlignment(new Error(`Native module alignment failed: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutTail.trim().length > 0) {
          this.onLog(mode, 'system', stdoutTail.trim());
        }
        if (stderrTail.trim().length > 0) {
          this.onLog(mode, 'system', stderrTail.trim());
        }

        if (code === 0) {
          resolveAlignment();
          return;
        }

        const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
        const detail = stderrCapture.trim();
        rejectAlignment(
          new Error(
            detail.length > 0
              ? `Native module alignment failed (${reason}): ${detail}`
              : `Native module alignment failed (${reason})`,
          ),
        );
      });
    });
  }

  async stop(mode: RuntimeMode): Promise<RuntimeProcessState> {
    const child = this.processes.get(mode);
    const state = this.states.get(mode)!;

    if (!child) {
      state.running = false;
      state.pid = null;
      return { ...state };
    }

    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5_000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolveStop();
      });

      child.kill('SIGTERM');
    });

    return { ...state };
  }

  async stopAll(): Promise<void> {
    await this.stop('dashboard');
    await this.stop('connect');
  }
}
