import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { desktopSystemProxyCliDataDir } from '../dev-instance.js';
import { WORKSPACE_APPS_DIR } from '../paths.js';
import { ACTIVE_CONFIG_PATH } from './active-config.js';

const { join, resolve } = path;

export type RuntimeMode = 'connect' | 'system-proxy' | 'tunnel';

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
  // system-proxy-mode options
  systemProxyPeerId?: string;
  systemProxyPort?: number;
  systemProxyProfiles?: string[];
  systemProxyDefaultModel?: string;
  systemProxyServedModels?: string[];
  setSystemProxy?: boolean;
  tunnelBuyerPort?: number;
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

const MIN_NODE_MAJOR_VERSION = 20;
const DEFAULT_CLI_COMMAND = 'antseed';
const CLI_COMMAND_ENV = 'ANTSEED_CLI_BIN';
const CLI_NODE_BIN_ENV = 'ANTSEED_NODE_BIN';
const LOCAL_CLI_BIN_RELATIVE = ['..', 'cli', 'dist', 'cli', 'index.js'] as const;
const RUNTIME_NATIVE_SCRIPT_RELATIVE = ['scripts', 'ensure-runtime-native-modules.mjs'] as const;
const RUNTIME_NATIVE_MARKER_FILE = '.runtime-native-meta.json';
const DEFAULT_CONFIG_PATH = join(homedir(), '.antseed', 'config.json');
const DEFAULT_CONNECT_DATA_DIR = join(homedir(), '.antseed');
const LEGACY_DESKTOP_DATA_ROOT = join(homedir(), '.antseed-desktop');
const LEGACY_DESKTOP_CONNECT_DATA_DIR = join(LEGACY_DESKTOP_DATA_ROOT, 'connect');
const CONNECT_DATA_DIR_ENV = 'ANTSEED_DESKTOP_CONNECT_DATA_DIR';

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

/**
 * Applies the buyer's selected model router (Preferences' "Select model
 * router" dropdown, persisted as `buyer.routingPreferences.
 * selectedRouterPackage` -- VprPreferencesView.tsx) to a connect-mode start.
 *
 * Loading a router package does not depend on `routerEnabled`.
 * `routerEnabled` can be live-synced to an already-running buyer daemon
 * via buyer-proxy's own hot-reload path, but nothing respawns the daemon --
 * gating plugin *loading* on it would mean a user who enables Auto after the
 * daemon already started (the common case, since it auto-starts before
 * Preferences is ever opened) gets stuck sending requests for the
 * auto-sentinel to a process that never loaded the selected router plugin at
 * all: a 502 "No policy-allowed peer currently serves model <sentinel>" with
 * no indication a restart was needed. Loading the plugin unconditionally is
 * harmless -- nothing can actually route through it unless the Auto catalog
 * entry is selectable at all, which is itself gated on the same preference
 * and reacts live (auto-router.ts's withAutoRouterCatalogEntry). What must
 * not happen unconditionally is forcing *every* connect-mode start
 * (including a genuine mainnet buyer with no router selected) onto some
 * particular package's own defaults -- `resolveSelectedRouterPackage()`
 * returning `null` (no package selected, for any reason) passes `opts`
 * through unchanged.
 *
 * Every selected package also gets a persistent per-plugin data directory
 * (`ANTSEED_ROUTER_DATA_DIR`, derived from its own package name so multiple
 * plugins don't collide on disk), for a plugin that wants to persist state
 * across a connect-mode subprocess restart. Beyond that, a package's name is
 * passed through as `opts.router` unchanged, and the CLI loads whatever
 * plugin that names using its own config -- this function has no
 * package-specific knowledge of any installed plugin, generic or otherwise.
 *
 * Applied here, at the single point every connect-mode `start()` call
 * ultimately funnels through (`ProcessManager.start` itself), rather than at
 * each individual caller -- there are at least two independent places that
 * start the connect runtime (a main-process auto-start on first chat message,
 * and a renderer-side auto-start on app boot that races ahead of it using its
 * own, unrelated router preference), and applying the override in only one of
 * them left the other silently winning the race with the wrong router. A
 * single choke point means neither caller needs to know this override exists.
 */
/**
 * Reads `buyer.routingPreferences.selectedRouterPackage` straight off disk,
 * no caching -- the config file is the one source of truth the renderer's
 * dropdown, a config-file edit, and this main-process check all agree on,
 * and a start() call is infrequent enough that a sync file read here is not
 * a real cost. `null` for anything not a real package name -- an explicit
 * "None" (VprPreferencesView.tsx writes `selectedRouterPackage: null`), the
 * field never having been set, or the config file missing/unreadable -- all
 * mean the same thing to a caller: load no router plugin at all.
 */
function resolveSelectedRouterPackage(): string | null {
  try {
    const raw = readFileSync(ACTIVE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      buyer?: { routingPreferences?: { selectedRouterPackage?: unknown } };
    };
    const pkg = parsed.buyer?.routingPreferences?.selectedRouterPackage;
    return typeof pkg === 'string' && pkg.trim().length > 0 ? pkg : null;
  } catch {
    return null;
  }
}

/**
 * Directory a router plugin can persist state in across connect-mode
 * subprocess restarts. Derived from the plugin's own package name, npm
 * scope stripped (`@scope/package-name` -> `package-name`) so different
 * plugins never share one directory.
 */
function routerPluginDataDir(packageName: string): string {
  const unscoped = packageName.replace(/^@[^/]+\//, '');
  const safe = unscoped.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return join(resolveConnectDataDir(), safe || 'router-plugin');
}

/**
 * For a connect-mode start, forces `opts.router` to whichever package the
 * buyer actually selected in Preferences and gives it a persistent data
 * directory to work with, regardless of what a caller happened to request --
 * see this function's own callers for why applying it centrally, once, beats
 * duplicating the same selection logic at each call site. A `null` selection
 * (nothing chosen, or explicitly set to "None") leaves `opts` untouched.
 *
 * A plugin needing environment tailored to the buyer's own configured chain
 * (e.g. its own local test-network addressing) is responsible for reading
 * that context and acting on it itself, the same way it reads any other
 * config the host passes into `createRouter`/`selectRoute` -- this function
 * has no host-side, package-specific knowledge of any installed plugin.
 */
export function applyRouterDemoOverride(
  opts: StartOptions,
  resolveRouterPackage: () => string | null = resolveSelectedRouterPackage,
): StartOptions {
  if (opts.mode !== 'connect') return opts;

  const selectedPackage = resolveRouterPackage();
  if (selectedPackage === null) return opts;

  return {
    ...opts,
    router: selectedPackage,
    env: {
      ...opts.env,
      ANTSEED_ROUTER_DATA_DIR: process.env['ANTSEED_ROUTER_DATA_DIR'] ?? routerPluginDataDir(selectedPackage),
    },
  };
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
    // Sibling workspace package, located from the app root rather than cwd.
    resolve(WORKSPACE_APPS_DIR, 'cli', 'dist', 'cli', 'index.js'),
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
  return paths.join(path.delimiter);
}

function detectNodeArch(nodeBinary: string): string | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.arch'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      killSignal: 'SIGKILL',
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function detectNodeMajorVersion(nodeBinary: string): number | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.versions.node.split(".")[0]'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      killSignal: 'SIGKILL',
    }).trim();
    const major = Number(output);
    return Number.isFinite(major) && major > 0 ? major : null;
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
  // When packaged, prefer Electron's own Node.js runtime — its version matches
  // the bundled native modules (better-sqlite3, node-datachannel).  A system
  // node with a different major version would fail to load those modules.
  const isPackaged = typeof process.resourcesPath === 'string'
    && existsSync(join(process.resourcesPath, 'app.asar'));
  if (isPackaged) {
    return process.execPath;
  }

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
  let firstCompatible: string | null = null;

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) {
      continue;
    }
    tried.add(candidate);
    if (candidate !== 'node' && !existsSync(candidate)) {
      continue;
    }
    const majorVersion = detectNodeMajorVersion(candidate);
    if (majorVersion === null) {
      // Candidate doesn't exist or can't execute — skip it entirely.
      continue;
    }
    if (!firstExisting) {
      firstExisting = candidate;
    }
    const meetsMinVersion = majorVersion >= MIN_NODE_MAJOR_VERSION;
    if (meetsMinVersion) {
      if (!firstCompatible) {
        firstCompatible = candidate;
      }
      const arch = detectNodeArch(candidate);
      if (arch === targetArch) {
        return candidate;
      }
    }
  }

  return firstCompatible ?? firstExisting ?? process.execPath ?? 'node';
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

export function resolveConnectDataDir(): string {
  const envDir = process.env[CONNECT_DATA_DIR_ENV]?.trim();
  if (envDir && envDir.length > 0) {
    if (envDir.startsWith('~/')) {
      return join(homedir(), envDir.slice(2));
    }
    return resolve(envDir);
  }
  return DEFAULT_CONNECT_DATA_DIR;
}

type CliExecution = {
  executable: string;
  executableArgsPrefix: string[];
  // True only for the local monorepo dev script — native module alignment is
  // only needed there. The bundled production CLI already ships aligned natives.
  isLocalDevScript: boolean;
  cliCommand: string;
};

function resolveCliExecution(): CliExecution {
  const cliCommand = resolveCliCommand();
  const localCliPath = resolveLocalCliPath();
  const isLocalDevScript = existsSync(localCliPath) && resolve(cliCommand) === localCliPath;

  // The bundled CLI (from extraResources) is also a .js script that needs node.
  // Packaged macOS apps have a minimal PATH, so we must resolve node explicitly.
  const isBundledScript = !isLocalDevScript && cliCommand.endsWith('.js');
  const needsNode = isLocalDevScript || isBundledScript;

  const executable = needsNode ? resolveNodeBinary(process.arch) : cliCommand;
  const executableArgsPrefix = needsNode ? [cliCommand] : [];
  return {
    executable,
    executableArgsPrefix,
    isLocalDevScript,
    cliCommand,
  };
}

export function resolveCommandArgs(opts: StartOptions): string[] {
  const args: string[] = [];

  if (opts.verbose) {
    args.push('--verbose');
  }

  const configPath = resolveConfigPath(opts.configPath);
  args.push('--config', configPath);

  switch (opts.mode) {
    case 'connect':
      args.push('--data-dir', resolveConnectDataDir());
      args.push('buyer', 'start');
      {
        const router = normalizeRouterIdentifier(opts.router);
        if (router !== 'local') {
          args.push('--router', router);
        }
      }
      break;
    case 'system-proxy':
      args.push('--data-dir', desktopSystemProxyCliDataDir() ?? resolveConnectDataDir());
      args.push('system-proxy', 'start');
      if (opts.systemProxyPeerId) {
        args.push('--peer', opts.systemProxyPeerId);
      }
      if (opts.systemProxyPort) {
        args.push('--port', String(opts.systemProxyPort));
      }
      for (const profile of opts.systemProxyProfiles ?? []) {
        args.push('--profile', profile);
      }
      if (opts.systemProxyDefaultModel) {
        args.push('--default-model', opts.systemProxyDefaultModel);
      }
      for (const model of opts.systemProxyServedModels ?? []) {
        args.push('--served-model', model);
      }
      if (opts.setSystemProxy) {
        args.push('--system-proxy');
      }
      break;
    case 'tunnel':
      args.push('--data-dir', resolveConnectDataDir());
      args.push('tunnel', 'start');
      if (opts.tunnelBuyerPort) args.push('--buyer-port', String(opts.tunnelBuyerPort));
      break;
    default:
      throw new Error(`Unsupported runtime mode: ${String(opts.mode)}`);
  }

  return args;
}

export class ProcessManager {
  private readonly processes = new Map<RuntimeMode, ChildProcessWithoutNullStreams>();
  private readonly attachedModes = new Set<RuntimeMode>();
  private readonly startPromises = new Map<RuntimeMode, Promise<RuntimeProcessState>>();
  private runtimeNativeAligned = false;
  private runtimeNativeAlignmentPromise: Promise<void> | null = null;
  private readonly states = new Map<RuntimeMode, RuntimeProcessState>([
    ['connect', { mode: 'connect', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
    ['system-proxy', { mode: 'system-proxy', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
    ['tunnel', { mode: 'tunnel', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
  ]);

  constructor(
    private readonly onLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void,
  ) {}

  getState(): RuntimeProcessState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  attach(mode: RuntimeMode): RuntimeProcessState {
    const state = this.states.get(mode)!;
    this.attachedModes.add(mode);
    state.running = true;
    state.pid = null;
    state.startedAt = Date.now();
    state.lastExitCode = null;
    state.lastError = null;
    this.onLog(mode, 'system', `Attached to existing ${mode} runtime`);
    return { ...state };
  }

  isAttached(mode: RuntimeMode): boolean {
    return this.attachedModes.has(mode);
  }

  detach(mode: RuntimeMode, reason: string): RuntimeProcessState {
    const state = this.states.get(mode)!;
    if (!this.attachedModes.delete(mode)) {
      return { ...state };
    }
    state.running = false;
    state.pid = null;
    state.lastError = reason;
    this.onLog(mode, 'system', reason);
    return { ...state };
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

  async start(rawOpts: StartOptions): Promise<RuntimeProcessState> {
    const opts = applyRouterDemoOverride(rawOpts);
    const mode = opts.mode;
    if (this.processes.has(mode)) {
      throw new Error(`${mode} is already running`);
    }
    const inFlightStart = this.startPromises.get(mode);
    if (inFlightStart) {
      return inFlightStart;
    }

    const startPromise = this.spawnForMode(mode, opts).finally(() => {
      this.startPromises.delete(mode);
    });
    this.startPromises.set(mode, startPromise);
    return startPromise;
  }

  private async spawnForMode(mode: RuntimeMode, opts: StartOptions): Promise<RuntimeProcessState> {
    this.attachedModes.delete(mode);

    const cliExecution = resolveCliExecution();
    const args = resolveCommandArgs(opts);
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];
    await this.ensureRuntimeNativeModules(mode, executable, cliExecution.isLocalDevScript);
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Desktop repairs the default router from its own app bundle. Do not let
    // the child CLI try an npm-based plugin refresh/install on locked-down
    // machines where npm may be unavailable or behind corporate TLS proxies.
    childEnv['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'] = '1';
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (typeof key === 'string' && key.trim().length > 0) {
        childEnv[key] = String(value);
      }
    }
    // When using Electron's own binary as node, set ELECTRON_RUN_AS_NODE so it
    // behaves like a regular Node.js process. Otherwise, remove it.
    if (executable === process.execPath) {
      childEnv['ELECTRON_RUN_AS_NODE'] = '1';
    } else {
      delete childEnv['ELECTRON_RUN_AS_NODE'];
    }
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `${path.delimiter}${childEnv['NODE_PATH']}` : '');
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
          `CLI command "${cliExecution.cliCommand}" was not found (executable: "${executable}"). Install Node.js ≥${MIN_NODE_MAJOR_VERSION} or set ${CLI_COMMAND_ENV} to a valid executable path.`,
        );
        return;
      }
      this.onLog(mode, 'system', `Process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (this.processes.get(mode) === child) {
        this.processes.delete(mode);
        state.running = false;
        state.pid = null;
        state.lastExitCode = code;
      }
      const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
      this.onLog(mode, 'system', `Process exited (${reason})`);
    });

    this.onLog(
      mode,
      'system',
      `Started ${mode} with "${executable}" (pid=${String(child.pid ?? 'unknown')})`,
    );
    if (mode === 'connect') {
      const dataDir = resolveConnectDataDir();
      this.onLog(mode, 'system', `Connect data dir: ${dataDir}`);
      if (dataDir === DEFAULT_CONNECT_DATA_DIR && existsSync(LEGACY_DESKTOP_CONNECT_DATA_DIR)) {
        this.onLog(
          mode,
          'system',
          `Legacy desktop connect data dir detected at ${LEGACY_DESKTOP_CONNECT_DATA_DIR}. Set ${CONNECT_DATA_DIR_ENV} to use it explicitly.`,
        );
      }
    }
    return { ...state };
  }

  async runCliCommand(args: string[], mode: RuntimeMode = 'connect'): Promise<CliCommandResult> {
    const cliExecution = resolveCliExecution();
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];

    const childEnv = { ...process.env };
    childEnv['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'] = '1';
    if (executable === process.execPath) {
      childEnv['ELECTRON_RUN_AS_NODE'] = '1';
    } else {
      delete childEnv['ELECTRON_RUN_AS_NODE'];
    }
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `${path.delimiter}${childEnv['NODE_PATH']}` : '');
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

  private async ensureRuntimeNativeModules(mode: RuntimeMode, executable: string, isLocalDevScript: boolean): Promise<void> {
    if (!isLocalDevScript) {
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

  async stop(mode: RuntimeMode, preserve = false): Promise<RuntimeProcessState> {
    const child = this.processes.get(mode);
    const state = this.states.get(mode)!;
    this.attachedModes.delete(mode);

    if (!child || preserve) {
      if (child) {
        this.processes.delete(mode);
        child.unref();
      }
      state.running = false;
      state.pid = null;
      return { ...state };
    }

    await new Promise<void>((resolveStop) => {
      let resolved = false;
      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(forceKillTimeout);
        clearTimeout(resolveTimeout);
        resolveStop();
      };

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
      const forceKillTimeout = timeout;
      const resolveTimeout = setTimeout(() => {
        this.processes.delete(mode);
        state.running = false;
        state.pid = null;
        finish();
      }, 7_500);

      child.once('exit', finish);

      child.kill('SIGTERM');
    });

    return { ...state };
  }

  async stopAll(): Promise<void> {
    await Promise.all([
      this.stop('system-proxy'),
      this.stop('connect'),
      this.stop('tunnel'),
    ]);
  }
}
