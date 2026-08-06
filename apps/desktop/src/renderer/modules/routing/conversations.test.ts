import { describe, expect, it } from 'vitest';
import { conversationMatchesApp } from './conversations';

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
