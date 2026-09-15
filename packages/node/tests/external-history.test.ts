import { describe, expect, it, vi } from 'vitest';
import { ExternalHistoryCollector, scoreExternalHistory, EXTERNAL_HISTORY_TTL_MS, ghfindProvider, trancoProvider,
  type GithubProjectHistory } from '../src/reputation/external-history.js';
import { routingReputationBreakdown } from '../src/reputation/routing-reputation.js';
import { isPublicIpv4, publicHttpsUrl } from '../src/reputation/public-json.js';
import { DefaultRouter } from '../src/routing/default-router.js';
import type { PeerInfo, PeerVerificationResults } from '../src/types/peer.js';
import type { SerializedHttpRequest } from '../src/types/http.js';

const NOW = Date.parse('2026-09-06T00:00:00Z');
const YEAR = 365.25 * 86_400_000;
const PEER_ID = 'a'.repeat(40) as PeerInfo['peerId'];

function verification(): PeerVerificationResults {
  return { verified: true, checkedAtMs: NOW,
    github: [{ username: 'portfolio', repository: 'proof', peerId: PEER_ID, verified: true, checkedAtMs: NOW }],
    domains: [{ domain: 'portfolio.example', peerId: PEER_ID, verified: true, checkedAtMs: NOW, attempts: [] }] };
}

function projects(count = 10, stars = 100, age = 4): GithubProjectHistory[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `project-${index}`, stars,
    archived: false, createdAtMs: NOW - age * YEAR }));
}

function peer(repos = projects()): PeerInfo {
  const results = verification();
  results.externalHistory = { version: 1, identities: [{ kind: 'github', claim: 'portfolio',
    status: 'available', identityId: 'github:42', createdAtMs: NOW - 10 * YEAR, fetchedAtMs: NOW, projects: repos }] };
  return { peerId: PEER_ID, providers: [], lastSeen: NOW, verificationResults: results };
}

describe('external history score with legacy v1 evidence', () => {
  it('bootstraps established original portfolios, not empty old accounts or proof repos', () => {
    expect(routingReputationBreakdown(peer(), NOW).effectiveReputationScore).toBe(70);
    for (const repos of [[], projects(1, 0, 10), projects(2, 0, 10), projects(30, 0, 0.1)]) {
      expect(scoreExternalHistory(peer(repos), NOW).points).toBe(0);
    }
    expect(scoreExternalHistory(peer(projects(8, 25, 0.75)), NOW).points).toBeGreaterThan(60);
    expect(scoreExternalHistory(peer(projects(8, 25, 0.75)), NOW).points).toBeLessThan(70);
  });

  it('caps stars per project and discounts archived history', () => {
    const capped = scoreExternalHistory(peer(projects(1, 500)), NOW).points;
    expect(scoreExternalHistory(peer(projects(1, 10_000_000)), NOW).points).toBe(capped);
    expect(capped).toBeLessThan(25);
    expect(scoreExternalHistory(peer(projects().map((project) => ({ ...project, archived: true }))), NOW).points).toBeLessThan(25);
  });

  it('excludes starred ownership-proof repositories and transferred pre-account projects', () => {
    expect(scoreExternalHistory(peer([{ ...projects(1)[0]!, name: 'proof' }]), NOW).points).toBe(0);
    expect(scoreExternalHistory(peer(projects(10, 100, 12)), NOW).points).toBe(0);
  });

  it('never adds multiple identities, duplicate projects or correlated domain evidence', () => {
    const source = peer();
    const evidence = source.verificationResults!.externalHistory!;
    evidence.identities.push(...evidence.identities, { kind: 'domain', claim: 'portfolio.example', status: 'available',
      identityId: 'domain:portfolio.example', fetchedAtMs: NOW, createdAtMs: NOW - 20 * YEAR });
    expect(scoreExternalHistory(source, NOW).points).toBe(70);
    expect(scoreExternalHistory(source, NOW).breakdown).toHaveLength(2);
    const single = projects(1);
    expect(scoreExternalHistory(peer([...single, ...single]), NOW).points).toBe(scoreExternalHistory(peer(single), NOW).points);
  });

  it('expires evidence and verification independently and rejects unknown versions/future timestamps', () => {
    expect(scoreExternalHistory(peer(), NOW + EXTERNAL_HISTORY_TTL_MS + 1).points).toBe(0);
    const source = peer();
    source.verificationResults!.externalHistory!.identities[0]!.fetchedAtMs = NOW + 1;
    expect(scoreExternalHistory(source, NOW).points).toBe(0);
    source.verificationResults!.externalHistory!.identities[0]!.fetchedAtMs = NOW;
    source.verificationResults!.github[0]!.verified = false;
    expect(scoreExternalHistory(source, NOW).points).toBe(0);
    const unknown = peer();
    (unknown.verificationResults!.externalHistory as { version: number }).version = 99;
    expect(scoreExternalHistory(unknown, NOW).points).toBe(0);
  });

  it('does not transfer proof to another peer, revoked claims, seller scores, or malformed persisted data', () => {
    const other = peer();
    other.peerId = 'b'.repeat(40) as PeerInfo['peerId'];
    expect(scoreExternalHistory(other, NOW).points).toBe(0);
    const revoked = peer();
    revoked.metadata = { verifications: {} } as PeerInfo['metadata'];
    expect(scoreExternalHistory(revoked, NOW).points).toBe(0);
    expect(routingReputationBreakdown({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100 }, NOW).effectiveReputationScore).toBe(0);
    expect(routingReputationBreakdown({ ...peer(), verificationResults: {} as PeerVerificationResults }, NOW).effectiveReputationScore).toBe(0);
  });

  it('penalizes ghost failures and risk rather than covering them with bootstrap credit', () => {
    expect(routingReputationBreakdown({ ...peer(), onChainGhostCount: 10 }, NOW).effectiveReputationScore).toBeLessThan(3);
    expect(routingReputationBreakdown({ ...peer(), onChainSybilRisk: 1 }, NOW).effectiveReputationScore).toBe(0);
    const configured = scoreExternalHistory(peer(), NOW, { maxGithubPoints: 20, maxDomainPoints: 0, maxAgeMs: EXTERNAL_HISTORY_TTL_MS });
    expect(configured.points).toBe(20);
  });

  it('retains price-first default routing and the minimum-reputation eligibility gate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const cheap = { ...peer([]), peerId: 'b'.repeat(40) as PeerInfo['peerId'], defaultInputUsdPerMillion: 1 };
      const established = { ...peer(), defaultInputUsdPerMillion: 2 };
      const request = {} as SerializedHttpRequest;
      expect(new DefaultRouter().selectPeer(request, [established, cheap])).toBe(cheap);
      expect(new DefaultRouter({ minReputation: 30 }).selectPeer(request, [cheap, established])).toBe(established);
    } finally { vi.useRealTimers(); }
  });
});

describe('GitHub follower credit v2', () => {
  function recognized(source = peer([]), count = 261, accountYears = 10): PeerInfo {
    const evidence = source.verificationResults!.externalHistory!;
    evidence.version = 2;
    Object.assign(evidence.identities[0]!, { followers: count, followersFetchedAtMs: NOW, createdAtMs: NOW - accountYears * YEAR });
    return source;
  }

  it('awards diminishing follower credit independently of owned projects', () => {
    const result = scoreExternalHistory(recognized(), NOW);
    expect(result.version).toBe(3);
    expect(result.followerPoints).toBeCloseTo(20 * Math.log1p(261) / Math.log1p(1_000));
    expect(result.points).toBe(result.followerPoints);
    expect(result.points).toBeGreaterThan(16);
    expect(result.points).toBeLessThan(17);
    expect(scoreExternalHistory(recognized(peer([]), 10_000_000), NOW).points).toBe(20);
    expect(scoreExternalHistory(recognized(peer([]), 0), NOW).points).toBe(0);
  });

  it('increases a small mature portfolio without increasing the overall ceiling', () => {
    const result = scoreExternalHistory(recognized(peer(projects(1, 21, 8)), 261, 14), NOW);
    expect(result.points).toBeGreaterThan(33);
    expect(result.points).toBeLessThan(34);
    expect(result.breakdown[0]!.followerPoints).toBe(result.followerPoints);
    const saturated = scoreExternalHistory(recognized(peer(), 10_000_000), NOW);
    expect(saturated.points).toBe(70);
    expect(saturated.followerPoints).toBe(0);
  });

  it('gates fresh accounts and ramps eligibility to one year', () => {
    expect(scoreExternalHistory(recognized(peer([]), 1_000, 0.1), NOW).points).toBe(0);
    expect(scoreExternalHistory(recognized(peer([]), 1_000, 0.25), NOW).points).toBe(0);
    expect(scoreExternalHistory(recognized(peer([]), 1_000, 0.625), NOW).points).toBeCloseTo(10);
    expect(scoreExternalHistory(recognized(peer([]), 1_000, 1), NOW).points).toBe(20);
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '261', undefined])('rejects malformed follower count %s', (count) => {
    const source = recognized();
    Object.assign(source.verificationResults!.externalHistory!.identities[0]!, { followers: count });
    expect(scoreExternalHistory(source, NOW).points).toBe(0);
  });

  it('requires fresh follower observations, ownership verification, and version 2 evidence', () => {
    for (const fetchedAt of [NOW + 1, NOW - EXTERNAL_HISTORY_TTL_MS - 1, undefined]) {
      const source = recognized();
      source.verificationResults!.externalHistory!.identities[0]!.followersFetchedAtMs = fetchedAt;
      expect(scoreExternalHistory(source, NOW).points).toBe(0);
    }
    const legacy = recognized();
    legacy.verificationResults!.externalHistory!.version = 1;
    expect(scoreExternalHistory(legacy, NOW).points).toBe(0);
    const unverified = recognized();
    unverified.verificationResults!.github[0]!.verified = false;
    expect(scoreExternalHistory(unverified, NOW).points).toBe(0);
  });

  it('deduplicates accounts and only reports followers from the strongest identity', () => {
    const source = recognized(peer([]), 10);
    const evidence = source.verificationResults!.externalHistory!;
    evidence.identities.push(evidence.identities[0]!);
    expect(scoreExternalHistory(source, NOW).breakdown).toHaveLength(1);
    evidence.identities.push({ kind: 'domain', claim: 'portfolio.example', identityId: 'domain:portfolio.example',
      status: 'available', createdAtMs: NOW - 10 * YEAR, fetchedAtMs: NOW });
    expect(scoreExternalHistory(source, NOW).points).toBe(12);
    expect(scoreExternalHistory(source, NOW).followerPoints).toBe(0);
  });

  it('preserves failure penalties and supports disabling or lowering follower credit', () => {
    const source = recognized();
    const result = routingReputationBreakdown({ ...source, onChainGhostCount: 10 }, NOW);
    expect(result.externalFollowerScore).toBeCloseTo(result.external.followerPoints * result.failureGate);
    expect(result.effectiveReputationScore).toBeLessThan(1);
    const policy = { maxGithubPoints: 70, maxDomainPoints: 12, maxAgeMs: EXTERNAL_HISTORY_TTL_MS, maxFollowerPoints: 0 };
    expect(scoreExternalHistory(source, NOW, policy).points).toBe(0);
    expect(scoreExternalHistory(source, NOW, { ...policy, maxFollowerPoints: 10 }).points).toBeCloseTo(scoreExternalHistory(source, NOW).points / 2);
    expect(scoreExternalHistory(source, NOW, { ...policy, maxFollowerPoints: 1_000 }).points).toBe(scoreExternalHistory(source, NOW).points);
    expect(scoreExternalHistory(source, NOW, { ...policy, maxFollowerPoints: NaN }).points).toBe(0);
  });
});

describe('third-party provider ranking v3', () => {
  function ranked(source: PeerInfo, rank: { source: string; points?: number; status?: 'available' | 'unavailable' }): PeerInfo {
    const evidence = source.verificationResults!.externalHistory!;
    evidence.version = 3;
    evidence.identities[0]!.thirdPartyRank = { status: 'available', fetchedAtMs: NOW, ...rank };
    return source;
  }

  it('adds ghfind points under the remaining GitHub headroom and reports the strongest provider score', () => {
    const result = scoreExternalHistory(ranked(peer([]), { source: 'ghfind', points: 72 }), NOW);
    expect(result.points).toBe(30);
    expect(result.breakdown[0]!.providerPoints).toBe(30);
    expect(result.breakdown[0]!.providerScore!.source).toBe('ghfind');
    const routing = routingReputationBreakdown(ranked(peer([]), { source: 'ghfind', points: 20 }), NOW);
    expect(routing.externalProviderScore).toBe(20);
    expect(routing.effectiveReputationScore).toBe(20);
    const ghosted = routingReputationBreakdown({ ...ranked(peer([]), { source: 'ghfind', points: 20 }), onChainGhostCount: 10 }, NOW);
    expect(ghosted.externalProviderScore).toBeCloseTo(20 * ghosted.failureGate);
  });

  it('never lifts an identity above its cap and prefers the strongest total', () => {
    const saturated = ranked(peer(), { source: 'ghfind', points: 100 });
    expect(scoreExternalHistory(saturated, NOW).points).toBe(70);
    expect(scoreExternalHistory(saturated, NOW).breakdown[0]!.providerPoints).toBeUndefined();
    const domains = ranked(peer(), { source: 'ghfind', points: 0 });
    const evidence = domains.verificationResults!.externalHistory!;
    evidence.identities.push({ kind: 'domain', claim: 'portfolio.example', identityId: 'domain:portfolio.example',
      status: 'available', createdAtMs: NOW - 5 * YEAR, fetchedAtMs: NOW,
      thirdPartyRank: { source: 'tranco', status: 'available', fetchedAtMs: NOW, points: 6 } });
    const result = scoreExternalHistory(domains, NOW);
    expect(result.points).toBe(70);
    expect(result.breakdown.map((entry) => entry.points)).toEqual([70, 12]);
  });

  it('requires version 3 evidence, fresh available ranks, and a registered provider of the right kind', () => {
    const legacy = ranked(peer([]), { source: 'ghfind', points: 20 });
    legacy.verificationResults!.externalHistory!.version = 2;
    expect(scoreExternalHistory(legacy, NOW).points).toBe(0);
    for (const mutate of [
      (source: PeerInfo) => { source.verificationResults!.externalHistory!.identities[0]!.thirdPartyRank!.status = 'unavailable'; },
      (source: PeerInfo) => { source.verificationResults!.externalHistory!.identities[0]!.thirdPartyRank!.fetchedAtMs = NOW - EXTERNAL_HISTORY_TTL_MS - 1; },
      (source: PeerInfo) => { source.verificationResults!.externalHistory!.identities[0]!.thirdPartyRank!.source = 'unknown'; },
      (source: PeerInfo) => { source.verificationResults!.externalHistory!.identities[0]!.thirdPartyRank!.source = 'tranco'; },
      (source: PeerInfo) => { source.verificationResults!.externalHistory!.identities[0]!.thirdPartyRank!.points = NaN; },
    ]) {
      const source = ranked(peer([]), { source: 'ghfind', points: 20 });
      mutate(source);
      expect(scoreExternalHistory(source, NOW).points).toBe(0);
    }
  });

  it('honours per-provider config and env opt-outs at scoring and collection time', async () => {
    vi.stubEnv('ANTSEED_RANK_GHFIND', '0');
    try {
      expect(scoreExternalHistory(ranked(peer([]), { source: 'ghfind', points: 20 }), NOW).points).toBe(0);
      expect(scoreExternalHistory(ranked(peer([]), { source: 'ghfind', points: 20 }), NOW, undefined, { disabled: ['tranco'] }).points).toBe(0);
      const getJson = vi.fn(async (): Promise<unknown> => { throw new Error('no network'); });
      const results = verification();
      results.domains = [];
      const evidence = await new ExternalHistoryCollector(getJson, () => NOW).collect(results);
      expect(evidence.identities[0]!.thirdPartyRank).toBeUndefined();
      expect(getJson.mock.calls.some(([url]) => String(url).includes('ghfind.com'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    const source = ranked(peer([]), { source: 'ghfind', points: 20 });
    expect(scoreExternalHistory(source, NOW, undefined, { disabled: ['ghfind'] }).points).toBe(0);
    const replacement = { ...ghfindProvider, name: 'mirror', defaultMaxPoints: 5 };
    const mirrored = ranked(peer([]), { source: 'mirror', points: 20 });
    expect(scoreExternalHistory(mirrored, NOW, undefined, { providers: [replacement] }).points).toBe(5);
  });

  it('collects ghfind scores for GitHub claims, caching the rank with the portfolio', async () => {
    const account = { id: 42, login: 'portfolio', created_at: '2016-01-01T00:00:00Z' };
    const repo = { id: 1, owner: { id: 42 }, name: 'original', size: 100, fork: false, archived: false, stargazers_count: 100, created_at: '2020-01-01T00:00:00Z' };
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('ghfind.com')
      ? { final_score: 72.4 } : url.includes('/repos?') ? [repo] : account);
    const collector = new ExternalHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.domains = [];
    const first = await collector.collect(results);
    expect(first.identities[0]!.thirdPartyRank).toEqual({ source: 'ghfind', status: 'available', fetchedAtMs: NOW,
      points: 72, sourceUrl: 'https://ghfind.com/api/score/portfolio' });
    await collector.collect(results);
    expect(getJson.mock.calls.filter(([url]) => String(url).includes('ghfind.com'))).toHaveLength(1);
  });

  it('collects Tranco ranks for domain claims and degrades gracefully when unlisted', async () => {
    const iana = { services: [[['example'], ['https://rdap.registry.example/']]] };
    const rdap = { objectClassName: 'domain', ldhName: 'portfolio.example', events: [{ eventAction: 'registration', eventDate: '2008-05-24T00:00:00Z' }] };
    const scoringRdap = { objectClassName: 'domain', ldhName: 'young.example', events: [{ eventAction: 'registration', eventDate: '2024-03-06T00:00:00Z' }] };
    let ranks: unknown = [{ date: '2026-09-01', rank: 250_000 }];
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('iana.org') ? iana
      : url.includes('tranco-list.eu') ? { roaster: { ranks } } : url.includes('young.example') ? scoringRdap : rdap);
    const collector = new ExternalHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.github = [];
    results.domains[0]!.domain = 'young.example';
    const evidence = await collector.collect(results);
    const rank = evidence.identities[0]!.thirdPartyRank!;
    expect(rank.source).toBe('tranco');
    expect(rank.status).toBe('available');
    expect(rank.points).toBeCloseTo(12 * Math.log(5_000_000 / 250_000) / Math.log(5_000_000));
    expect(rank.points).toBeLessThan(12);
    const scored = peer([]);
    const githubIdentity = scored.verificationResults!.externalHistory!.identities[0]!;
    githubIdentity.thirdPartyRank = { source: 'ghfind', status: 'unavailable', fetchedAtMs: NOW };
    scored.verificationResults!.externalHistory!.version = 3;
    scored.verificationResults!.domains[0]!.domain = 'young.example';
    scored.verificationResults!.externalHistory!.identities.push({ ...evidence.identities[0]! });
    const result = scoreExternalHistory(scored, NOW);
    const domainEntry = result.breakdown.find((entry) => entry.identityId.startsWith('domain:'))!;
    expect(domainEntry.agePoints).toBeGreaterThan(4);
    expect(domainEntry.agePoints).toBeLessThan(12);
    expect(domainEntry.providerPoints).toBeGreaterThan(0);
    expect(domainEntry.agePoints + domainEntry.providerPoints!).toBeCloseTo(domainEntry.points);
    expect(result.points).toBe(domainEntry.points);

    ranks = [];
    const unlisted = await new ExternalHistoryCollector(getJson, () => NOW).collect(results);
    expect(unlisted.identities[0]!.thirdPartyRank!.status).toBe('unavailable');
    expect(unlisted.identities[0]!.thirdPartyRank!.points).toBeUndefined();
  });

  it('exposes provider defaults', () => {
    expect(ghfindProvider.kinds).toEqual(['github']);
    expect(ghfindProvider.defaultMaxPoints).toBe(30);
    expect(trancoProvider.kinds).toEqual(['domain']);
    expect(trancoProvider.defaultMaxPoints).toBe(12);
  });
});

describe('buyer-local collection', () => {
  const account = { id: 42, login: 'portfolio', created_at: '2016-01-01T00:00:00Z' };
  const repo = { id: 1, owner: { id: 42 }, name: 'original', size: 100, fork: false, archived: false, stargazers_count: 100, created_at: '2020-01-01T00:00:00Z' };

  it('refreshes followers from the existing account lookup while retaining cached portfolio timestamps', async () => {
    let followers: unknown = 261;
    let now = NOW;
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?') ? [repo] : { ...account, followers });
    const collector = new ExternalHistoryCollector(getJson, () => now);
    const results = verification();
    results.domains = [];
    const first = await collector.collect(results);
    expect(first.version).toBe(3);
    expect(first.identities[0]!.followers).toBe(261);
    expect(first.identities[0]!.followersFetchedAtMs).toBe(NOW);
    followers = 0;
    now += 60_000;
    const second = await collector.collect(results);
    expect(second.identities[0]!.followers).toBe(0);
    expect(second.identities[0]!.followersFetchedAtMs).toBe(now);
    expect(second.identities[0]!.fetchedAtMs).toBe(NOW);
    expect(first.identities[0]!.followers).toBe(261);
    followers = 'invalid';
    const third = await collector.collect(results);
    expect(third.identities[0]!.followers).toBeUndefined();
    expect(third.identities[0]!.followersFetchedAtMs).toBeUndefined();
    expect(third.identities[0]!.status).toBe('available');
    expect(getJson.mock.calls.filter(([url]) => url.includes('/repos?'))).toHaveLength(1);
    expect(getJson).toHaveBeenCalledTimes(5);
  });

  it('collects original projects, excludes forks/wrong owners, and caches by stable ID', async () => {
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?')
      ? [repo, { ...repo, id: 2, fork: true }, { ...repo, id: 3, owner: { id: 99 } }, { ...repo, id: 4, size: 0 }]
      : account);
    const collector = new ExternalHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.domains = [];
    results.github.push({ ...results.github[0]! });
    const first = await collector.collect(results);
    expect(first.identities).toHaveLength(1);
    expect(first.identities[0]!.projects).toHaveLength(1);
    expect(first.identities[0]!.identityId).toBe('github:42');
    await collector.collect(results);
    expect(getJson.mock.calls.filter(([url]) => url.includes('/repos?'))).toHaveLength(1);
    expect(getJson).toHaveBeenCalledTimes(4);
  });

  it('does not lend cached history to a reassigned username', async () => {
    let accountId = 42;
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?')
      ? accountId === 42 ? [repo] : [] : { ...account, id: accountId });
    const collector = new ExternalHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.domains = [];
    await collector.collect(results);
    accountId = 99;
    const next = await collector.collect(results);
    expect(next.identities[0]!.identityId).toBe('github:99');
    expect(next.identities[0]!.projects).toEqual([]);
  });

  it('paginates under a strict five-request budget and records truncation', async () => {
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?') ? Array.from({ length: 100 }, (_, index) => ({ ...repo, id: index + 1 })) : account);
    const results = verification();
    results.domains = [];
    const evidence = await new ExternalHistoryCollector(getJson, () => NOW).collect(results);
    expect(getJson).toHaveBeenCalledTimes(6);
    expect(evidence.identities[0]!.truncated).toBe(true);
    expect(evidence.identities[0]!.projects).toHaveLength(100);
  });

  it('uses IANA discovery and exact RDAP registration matches, never parent age', async () => {
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('iana.org')
      ? { services: [[['example'], ['https://rdap.registry.example/']]] }
      : { objectClassName: 'domain', ldhName: 'portfolio.example', events: [{ eventAction: 'registration', eventDate: '2008-05-24T00:00:00Z' }] });
    const collector = new ExternalHistoryCollector(getJson, () => NOW);
    const results = verification();
    results.github = [];
    expect((await collector.collect(results)).identities[0]!.status).toBe('available');
    results.domains[0]!.domain = 'sub.portfolio.example';
    expect((await collector.collect(results)).identities[0]!.status).toBe('unavailable');
    expect(getJson.mock.calls.filter(([url]) => url.includes('iana.org'))).toHaveLength(1);
  });

  it('does not fetch unverified identities and distinguishes unavailable public data', async () => {
    const getJson = vi.fn(async (): Promise<unknown> => { throw new Error('rate limited'); });
    const results = verification();
    results.domains = [];
    results.github[0]!.verified = false;
    const collector = new ExternalHistoryCollector(getJson, () => NOW);
    expect((await collector.collect(results)).identities).toEqual([]);
    expect(getJson).not.toHaveBeenCalled();
    results.github[0]!.verified = true;
    const evidence = await collector.collect(results);
    expect(evidence.identities[0]!.status).toBe('unavailable');
    expect(results.github[0]!.verified).toBe(true);
  });

  it('expires portfolio cache after seven days and bounds distinct claims per pass', async () => {
    let now = NOW;
    const getJson = vi.fn(async (url: string): Promise<unknown> => url.includes('/repos?') ? [repo] : account);
    const collector = new ExternalHistoryCollector(getJson, () => now);
    const results = verification();
    results.domains = [];
    await collector.collect(results);
    now += EXTERNAL_HISTORY_TTL_MS + 1;
    await collector.collect(results);
    expect(getJson.mock.calls.filter(([url]) => url.includes('/repos?'))).toHaveLength(2);
    const many = verification();
    many.github = [];
    many.domains = Array.from({ length: 20 }, (_, index) => ({ ...many.domains[0]!, domain: `domain${index}.example` }));
    const evidence = await collector.collect(many);
    expect(evidence.identities).toHaveLength(8);
  });

  it('rejects unsafe bootstrap endpoints before making a registry request', async () => {
    const getJson = vi.fn(async (): Promise<unknown> => ({ services: [[['example'], ['https://127.0.0.1/']]] }));
    const results = verification();
    results.github = [];
    expect((await new ExternalHistoryCollector(getJson, () => NOW).collect(results)).identities[0]!.status).toBe('unavailable');
    expect(getJson).toHaveBeenCalledTimes(1);
  });
});

describe('public network restrictions', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '198.18.1.1', '224.0.0.1', '::1', '::ffff:127.0.0.1'])('blocks %s', (address) => {
    expect(isPublicIpv4(address)).toBe(false);
  });
  it.each(['http://example.com', 'https://127.0.0.1', 'https://user:pass@example.com', 'https://example.com:444', 'https://localhost'])('rejects %s', (url) => {
    expect(() => publicHttpsUrl(url)).toThrow();
  });
  it('accepts public IPv4 addresses and normal HTTPS hosts', () => {
    expect(isPublicIpv4('8.8.8.8')).toBe(true);
    expect(publicHttpsUrl('https://api.github.com/users/example').hostname).toBe('api.github.com');
  });
});
