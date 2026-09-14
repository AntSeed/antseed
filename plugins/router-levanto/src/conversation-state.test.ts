import { describe, expect, it } from 'vitest';
import { ConversationState } from './conversation-state.js';

describe('ConversationState cached-token estimator', () => {
  it('a candidate never used in this conversation expects zero cached tokens', () => {
    const state = new ConversationState();
    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 1000)).toBe(0);
  });

  it('estimates from the observed ratio, capped at the current prompt size', () => {
    const state = new ConversationState();
    const now = 1_000_000;
    // Last turn: 1000 prompt tokens, 400 came back cached -- ratio 0.4.
    state.recordObservedCache('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, 400, now);

    // Current turn grew to 1500 tokens -- expected cached = min(1000*0.4, 1500) = 400.
    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 1500, now)).toBe(400);
    // Current turn shrank to 300 -- capped at the current size.
    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 300, now)).toBe(300);
  });

  it('decays to zero after the flat 3-minute timeout', () => {
    const state = new ConversationState();
    const now = 1_000_000;
    state.recordObservedCache('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, 500, now);

    const justUnder = now + 3 * 60 * 1000 - 1;
    const justOver = now + 3 * 60 * 1000 + 1;
    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, justUnder)).toBeGreaterThan(0);
    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, justOver)).toBe(0);
  });

  it('smooths the ratio across turns (EMA), not just the latest turn', () => {
    const state = new ConversationState();
    const now = 1_000_000;
    state.recordObservedCache('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, 1000, now); // ratio 1.0
    state.recordObservedCache('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, 0, now); // ratio 0.0

    const expected = state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, now);
    // Smoothed ratio should sit strictly between the two extremes, not just be the latest (0).
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(1000);
  });

  it('tracks (model, peer) pairs independently within the same conversation', () => {
    const state = new ConversationState();
    const now = 1_000_000;
    state.recordObservedCache('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, 800, now);

    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, now)).toBe(800);
    // A different peer serving the same model never saw this conversation.
    expect(state.expectedCachedTokens('conv-1', 'gpt-5.6-luna', '0xBBB', 1000, now)).toBe(0);
  });

  it('keeps conversations independent', () => {
    const state = new ConversationState();
    const now = 1_000_000;
    state.recordObservedCache('conv-1', 'gpt-5.6-luna', '0xAAA', 1000, 800, now);
    expect(state.expectedCachedTokens('conv-2', 'gpt-5.6-luna', '0xAAA', 1000, now)).toBe(0);
  });
});

describe('ConversationState pin', () => {
  it('records the selected model without storing or comparing the user text', () => {
    const state = new ConversationState();
    state.recordDecision('conv-1', {
      peer: { peerId: '0xAAA' } as never, peerId: '0xAAA', serviceId: 'gpt-5.6-luna',
      reputation: 0, hasCachedInputPricing: false, inputUsdPerMillion: null, outputUsdPerMillion: null, minImageUsdPerImage: null,
    });
    expect(state.getPinned('conv-1')?.serviceId).toBe('gpt-5.6-luna');
  });

  it('getPinned returns null until a decision has been recorded', () => {
    const state = new ConversationState();
    expect(state.getPinned('conv-1')).toBeNull();
  });

  it('evicts the least-recently-routed conversation once the cap is exceeded', () => {
    const state = new ConversationState();
    const pinned = {
      peer: { peerId: '0xAAA' } as never, peerId: '0xAAA', serviceId: 'gpt-5.6-luna',
      reputation: 0, hasCachedInputPricing: false, inputUsdPerMillion: null, outputUsdPerMillion: null, minImageUsdPerImage: null,
    };
    for (let i = 0; i < 500; i++) {
      state.recordDecision(`conv-${i}`, pinned as never);
    }
    expect(state.getPinned('conv-0')).not.toBeNull();

    state.recordDecision('conv-500', pinned as never);

    expect(state.getPinned('conv-0')).toBeNull();
    expect(state.getPinned('conv-500')).not.toBeNull();
  });
});
