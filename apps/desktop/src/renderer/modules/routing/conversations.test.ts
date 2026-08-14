import { describe, expect, it } from 'vitest';
import { conversationMatchesApp, conversationPinnedServiceId } from './conversations';

describe('conversationMatchesApp', () => {
  it('matches on the profile name with prefix flexibility', () => {
    expect(conversationMatchesApp('codex', { name: 'codex' })).toBe(true);
    expect(conversationMatchesApp('codex-exec', { name: 'codex' })).toBe(true);
    expect(conversationMatchesApp('codex', { name: 'codex-cli' })).toBe(true);
    expect(conversationMatchesApp('opencode', { name: 'codex' })).toBe(false);
  });

  it('matches on configured client names (toolSlugs), not just the profile name', () => {
    const app = { name: 'vendor', toolSlugs: ['acme-code', 'acme-cli'] };
    expect(conversationMatchesApp('acme-cli', app)).toBe(true);
    expect(conversationMatchesApp('acme-code', app)).toBe(true);
    expect(conversationMatchesApp('acme-code-subagent', app)).toBe(true);
    expect(conversationMatchesApp('codex', app)).toBe(false);
  });

  it('keeps the profile name as a fallback when slugs are configured', () => {
    expect(conversationMatchesApp('opencode', { name: 'opencode', toolSlugs: ['oc-desktop'] })).toBe(true);
  });

  it('ignores empty slug entries', () => {
    expect(conversationMatchesApp('anything', { name: 'custom-api', toolSlugs: [''] })).toBe(false);
  });
});

describe('conversationPinnedServiceId', () => {
  const conversation = {
    id: 'opencode:session',
    tool: 'opencode',
    sessionKey: 'session',
    snippet: 'hello',
    label: null,
    pinnedModel: null,
    lastModel: `${'a'.repeat(40)}@qwen3-coder`,
    createdAt: 1,
    lastActiveAt: 1,
  };

  it('shows the resolved automatic route when no manual pin exists', () => {
    expect(conversationPinnedServiceId(conversation)).toBe('qwen3-coder');
  });

  it('shows a manual pin ahead of the last automatic route', () => {
    expect(conversationPinnedServiceId({
      ...conversation,
      pinnedModel: `${'b'.repeat(40)}@gpt-5.4`,
    })).toBe('gpt-5.4');
  });
});
