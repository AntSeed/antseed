import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { DHTHealthMonitor } from '../src/discovery/dht-health.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

function makeConfig(overrides: Partial<AnnouncerConfig> = {}): {
  config: AnnouncerConfig;
  dht: { announce: ReturnType<typeof vi.fn> };
} {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());

  const dht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const config: AnnouncerConfig = {
    identity: { peerId, privateKey, wallet },
    dht: dht as unknown as AnnouncerConfig['dht'],
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-sonnet'],
        maxConcurrency: 5,
      },
    ],
    region: 'us',
    pricing: new Map([
      ['anthropic', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]),
    reannounceIntervalMs: 60 * 60_000,
    signalingPort: 6882,
    ...overrides,
  };

  return { config, dht };
}

describe('PeerAnnouncer retry on announce failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a retry within the reannounce interval after any announce failure', async () => {
    const { config, dht } = makeConfig();
    dht.announce.mockRejectedValue(new Error('dht down'));
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const callsAfterFirst = dht.announce.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // First backoff is 60s — advance and let the retry fire.
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    expect(dht.announce.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    announcer.stopPeriodicAnnounce();
  });

  it('backs off exponentially across repeated failures', async () => {
    const { config, dht } = makeConfig();
    dht.announce.mockRejectedValue(new Error('dht down'));
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const callsAfterFirst = dht.announce.mock.calls.length;

    // First retry fires ~60s after the original failure.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dht.announce.mock.calls.length).toBe(callsAfterFirst);
    await vi.advanceTimersByTimeAsync(30_100);
    const callsAfterFirstRetry = dht.announce.mock.calls.length;
    expect(callsAfterFirstRetry).toBeGreaterThan(callsAfterFirst);

    // Second retry scheduled with the next backoff (120s) relative to the first
    // retry firing. Confirm 119s isn't enough and ~121s is.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(dht.announce.mock.calls.length).toBe(callsAfterFirstRetry);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dht.announce.mock.calls.length).toBeGreaterThan(callsAfterFirstRetry);

    announcer.stopPeriodicAnnounce();
  });

  it('cancels the pending retry and resets the backoff when an announce succeeds', async () => {
    const { config, dht } = makeConfig();
    dht.announce.mockRejectedValueOnce(new Error('transient'));
    dht.announce.mockResolvedValue(undefined);
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const callsAfterFail = dht.announce.mock.calls.length;

    // Succeed on the next cycle before the 60s retry fires.
    await announcer.announce();
    const callsAfterSuccess = dht.announce.mock.calls.length;

    // Advance past the original retry window — no extra calls should happen.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dht.announce.mock.calls.length).toBe(callsAfterSuccess);
    expect(callsAfterSuccess).toBeGreaterThan(callsAfterFail);

    announcer.stopPeriodicAnnounce();
  });

  it('stopPeriodicAnnounce prevents a pending retry from firing', async () => {
    const { config, dht } = makeConfig();
    dht.announce.mockRejectedValue(new Error('dht down'));
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const callsAfterFail = dht.announce.mock.calls.length;

    announcer.stopPeriodicAnnounce();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(dht.announce.mock.calls.length).toBe(callsAfterFail);
  });

  it('does not arm a retry when an announce fails after stopPeriodicAnnounce', async () => {
    // The race this guards: stop runs while an announce() is mid-flight;
    // when the announce eventually fails, _scheduleRetryAfterFailure must
    // not arm a new timer. Directly exercise the post-stop path by calling
    // announce() after stop and confirming no retry fires.
    const { config, dht } = makeConfig();
    dht.announce.mockRejectedValue(new Error('late failure'));
    const announcer = new PeerAnnouncer(config);

    announcer.stopPeriodicAnnounce();
    await announcer.announce();

    const callsAfterStop = dht.announce.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(dht.announce.mock.calls.length).toBe(callsAfterStop);
  });

  it('records announce outcomes to the provided DHTHealthMonitor', async () => {
    const monitor = new DHTHealthMonitor(() => 10);
    const { config, dht } = makeConfig({ healthMonitor: monitor });
    dht.announce
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue(undefined);
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const snap = monitor.getSnapshot();
    expect(snap.totalAnnounces).toBeGreaterThan(0);
    expect(snap.failedAnnounces).toBeGreaterThan(0);
    expect(snap.successfulAnnounces).toBeGreaterThan(0);

    announcer.stopPeriodicAnnounce();
  });
});
