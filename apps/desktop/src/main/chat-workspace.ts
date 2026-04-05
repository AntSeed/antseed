import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { asErrorMessage } from './utils.js';

export const ANTSEED_HOME_DIR = path.join(homedir(), '.antseed');
export const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
export const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
const CHAT_WORKSPACE_STATE_FILE = path.join(CHAT_DATA_DIR, 'workspace.json');

export type ChatWorkspaceGitStatus = {
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

export function getCurrentChatWorkspaceDir(): string {
  return currentChatWorkspaceDir;
}

export async function loadChatWorkspaceDir(): Promise<string> {
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

export async function persistChatWorkspaceDir(workspaceDir: string): Promise<string> {
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

export async function getWorkspaceGitStatus(workspaceDir: string): Promise<ChatWorkspaceGitStatus> {
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
