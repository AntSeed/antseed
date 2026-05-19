import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_DATA_DIR } from './chat-workspace.js';

export type ChatPermissionMode = 'manual' | 'full';
export type ToolApprovalDecision = 'allow_once' | 'always_allow_peer' | 'deny';

export type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  workspacePath: string;
  peerId: string | null;
  peerName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

const TOOL_PERMISSION_FILE = path.join(CHAT_DATA_DIR, 'tool-permissions.json');
const RISKY_TOOLS = new Set(['bash', 'edit', 'write', 'start_dev_server']);

type PersistedToolPermissions = {
  /** Allowances are intentionally peer-scoped. Full access is the only global trust shortcut. */
  peerAllow: Record<string, string[]>;
};

let cache: PersistedToolPermissions | null = null;

export function normalizePermissionMode(value: unknown): ChatPermissionMode {
  return value === 'manual' ? 'manual' : 'full';
}

export function requiresToolApproval(mode: ChatPermissionMode, toolName: string): boolean {
  return mode === 'manual' && RISKY_TOOLS.has(toolName);
}

function normalizePeerId(peerId: string | null | undefined): string | null {
  const trimmed = peerId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function loadPermissions(): Promise<PersistedToolPermissions> {
  if (cache) return cache;
  try {
    const raw = await readFile(TOOL_PERMISSION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedToolPermissions> & {
      // Pre-peer-scoped V1 used workspaceAllow. Ignore it so approvals do not leak
      // across providers after the peer-scoping change.
      workspaceAllow?: Record<string, string[]>;
    };
    const peerAllow: Record<string, string[]> = {};
    if (parsed.peerAllow && typeof parsed.peerAllow === 'object') {
      for (const [peerId, tools] of Object.entries(parsed.peerAllow)) {
        const normalizedPeerId = normalizePeerId(peerId);
        if (!normalizedPeerId || !Array.isArray(tools)) continue;
        peerAllow[normalizedPeerId] = tools.filter((tool): tool is string => typeof tool === 'string');
      }
    }
    cache = { peerAllow };
  } catch {
    cache = { peerAllow: {} };
  }
  return cache;
}

async function savePermissions(next: PersistedToolPermissions): Promise<void> {
  cache = next;
  await mkdir(CHAT_DATA_DIR, { recursive: true });
  await writeFile(TOOL_PERMISSION_FILE, JSON.stringify(next, null, 2), 'utf8');
}

export async function isToolAllowedForPeer(peerId: string | null | undefined, toolName: string): Promise<boolean> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) return false;
  const permissions = await loadPermissions();
  return permissions.peerAllow[normalizedPeerId]?.includes(toolName) ?? false;
}

export async function allowToolForPeer(peerId: string | null | undefined, toolName: string): Promise<void> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) {
    throw new Error('Cannot persist tool approval without a peer id');
  }
  const permissions = await loadPermissions();
  const tools = new Set(permissions.peerAllow[normalizedPeerId] ?? []);
  tools.add(toolName);
  permissions.peerAllow[normalizedPeerId] = Array.from(tools).sort();
  await savePermissions(permissions);
}

function peerSuffix(peerId: string | null | undefined): string {
  return normalizePeerId(peerId) ? 'for this peer' : 'once';
}

export function describeToolApproval(toolName: string, input: Record<string, unknown>, peerId?: string | null): Pick<ToolApprovalRequest, 'title' | 'description' | 'subject' | 'alwaysAllowLabel' | 'canAlwaysAllow'> {
  const canAlwaysAllow = Boolean(normalizePeerId(peerId));
  if (toolName === 'bash') {
    return {
      title: 'Approve command?',
      description: 'The agent wants to run a terminal command.',
      subject: typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow bash ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'edit') {
    return {
      title: 'Approve file edit?',
      description: 'The agent wants to modify a file.',
      subject: typeof input.path === 'string' ? input.path : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow edits ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'write') {
    return {
      title: 'Approve file write?',
      description: 'The agent wants to write a file.',
      subject: typeof input.path === 'string' ? input.path : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow writes ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'start_dev_server') {
    return {
      title: 'Approve dev server?',
      description: 'The agent wants to start a long-running development server.',
      subject: typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow dev servers ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  return {
    title: 'Approve tool?',
    description: `The agent wants to run ${toolName}.`,
    subject: JSON.stringify(input, null, 2),
    alwaysAllowLabel: `Always allow ${toolName} ${peerSuffix(peerId)}`,
    canAlwaysAllow,
  };
}
