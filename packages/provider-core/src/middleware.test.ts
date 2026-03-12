import { describe, it, expect } from 'vitest';
import { applyMiddleware, type ProviderMiddleware } from './middleware.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mw(content: string, position: ProviderMiddleware['position'], role?: string): ProviderMiddleware {
  return role ? { content, position, role } : { content, position };
}

// ---------------------------------------------------------------------------
// Anthropic format — top-level `system` string
// ---------------------------------------------------------------------------

describe('system-prepend (Anthropic string system)', () => {
  it('prepends to existing system string', () => {
    const body = { system: 'original', messages: [] };
    const result = applyMiddleware(body, [mw('injected', 'system-prepend')]);
    expect(result.system).toBe('injected\n\noriginal');
  });

  it('creates system field when absent', () => {
    const body = { messages: [] };
    const result = applyMiddleware(body, [mw('injected', 'system-prepend')]);
    expect(result.system).toBe('injected');
  });
});

describe('system-append (Anthropic string system)', () => {
  it('appends to existing system string', () => {
    const body = { system: 'original', messages: [] };
    const result = applyMiddleware(body, [mw('injected', 'system-append')]);
    expect(result.system).toBe('original\n\ninjected');
  });

  it('creates system field when null', () => {
    const body = { system: null, messages: [] };
    const result = applyMiddleware(body, [mw('injected', 'system-append')]);
    expect(result.system).toBe('injected');
  });
});

// ---------------------------------------------------------------------------
// Anthropic format — top-level `system` array of content blocks
// ---------------------------------------------------------------------------

describe('system-prepend (Anthropic array system)', () => {
  it('prepends a text block to the array', () => {
    const existing = [{ type: 'text', text: 'original' }];
    const body = { system: existing, messages: [] };
    const result = applyMiddleware(body, [mw('injected', 'system-prepend')]);
    expect(result.system).toEqual([{ type: 'text', text: 'injected' }, ...existing]);
  });
});

describe('system-append (Anthropic array system)', () => {
  it('appends a text block to the array', () => {
    const existing = [{ type: 'text', text: 'original' }];
    const body = { system: existing, messages: [] };
    const result = applyMiddleware(body, [mw('injected', 'system-append')]);
    expect(result.system).toEqual([...existing, { type: 'text', text: 'injected' }]);
  });
});

// ---------------------------------------------------------------------------
// OpenAI format — system prompt lives inside `messages` array
// ---------------------------------------------------------------------------

describe('system-prepend (OpenAI messages format)', () => {
  it('inserts a system message at index 0 when no system present', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const result = applyMiddleware(body, [mw('injected', 'system-prepend')], 'openai');
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: 'system', content: 'injected' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('inserts before existing system messages', () => {
    const body = { messages: [{ role: 'system', content: 'existing' }, { role: 'user', content: 'hi' }] };
    const result = applyMiddleware(body, [mw('injected', 'system-prepend')], 'openai');
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: 'system', content: 'injected' });
    expect(msgs[1]).toEqual({ role: 'system', content: 'existing' });
  });
});

describe('system-append (OpenAI messages format)', () => {
  it('inserts after the last system message', () => {
    const body = {
      messages: [
        { role: 'system', content: 'sys1' },
        { role: 'user', content: 'hi' },
      ],
    };
    const result = applyMiddleware(body, [mw('injected', 'system-append')], 'openai');
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys1' });
    expect(msgs[1]).toEqual({ role: 'system', content: 'injected' });
    expect(msgs[2]).toEqual({ role: 'user', content: 'hi' });
  });

  it('appends at end when no system message exists', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const result = applyMiddleware(body, [mw('injected', 'system-append')], 'openai');
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' });
    expect(msgs[1]).toEqual({ role: 'system', content: 'injected' });
  });
});

// ---------------------------------------------------------------------------
// messages prepend / append
// ---------------------------------------------------------------------------

describe('prepend position', () => {
  it('inserts as first message with default user role', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const result = applyMiddleware(body, [mw('skill content', 'prepend')]);
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[0]).toEqual({ role: 'user', content: 'skill content' });
  });

  it('respects custom role', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const result = applyMiddleware(body, [mw('sys hint', 'prepend', 'system')]);
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[0].role).toBe('system');
  });
});

describe('append position', () => {
  it('inserts as last message with default user role', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const result = applyMiddleware(body, [mw('reminder', 'append')]);
    const msgs = result.messages as { role: string; content: string }[];
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'reminder' });
  });
});

// ---------------------------------------------------------------------------
// Multiple middleware applied in order
// ---------------------------------------------------------------------------

describe('multiple middleware', () => {
  it('applies all in sequence', () => {
    const body = { system: 'base', messages: [] };
    const result = applyMiddleware(body, [
      mw('first', 'system-prepend'),
      mw('last', 'system-append'),
    ]);
    expect(result.system).toBe('first\n\nbase\n\nlast');
  });
});

// ---------------------------------------------------------------------------
// No-op
// ---------------------------------------------------------------------------

describe('empty middleware list', () => {
  it('returns the original body reference unchanged', () => {
    const body = { system: 'x', messages: [] };
    const result = applyMiddleware(body, []);
    expect(result).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// models filter (ProviderMiddleware.services) — note: filtering is enforced by
// MiddlewareProvider before calling applyMiddleware; these tests confirm the
// field is accepted on the type and that passing a pre-filtered list works.
// ---------------------------------------------------------------------------

describe('services field on ProviderMiddleware', () => {
  it('applies when services list matches', () => {
    const body = { system: 'base', messages: [] };
    const filtered = [{ content: 'injected', position: 'system-prepend' as const, services: ['model-a'] }];
    const result = applyMiddleware(body, filtered);
    expect(result.system).toBe('injected\n\nbase');
  });

  it('is a no-op when caller passes an empty list (filtered out upstream)', () => {
    const body = { system: 'base', messages: [] };
    const result = applyMiddleware(body, []);
    expect(result).toBe(body);
  });
});
