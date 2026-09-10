import type { PeerInfo, PeerVerificationResults } from '../types/peer.js';
import { fetchPublicJson, publicHttpsUrl } from './public-json.js';

export const EXTERNAL_HISTORY_VERSION = 3;
export const EXTERNAL_HISTORY_TTL_MS = 7 * 86_400_000;
const RETRY_MS = 60 * 60_000;
const MAX_IDENTITIES = 8;

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return publicHttpsUrl(value).href; } catch { return undefined; }
}

function disabledByEnv(name: string): boolean {
  const raw = typeof process !== 'undefined' ? process.env?.[`ANTSEED_RANK_${name.toUpperCase()}`] : undefined;
  return raw !== undefined && ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export interface GithubProjectHistory {
  id: number;
  name: string;
  createdAtMs: number;
  stars: number;
  archived: boolean;
}

export interface ThirdPartyRank {
  source: string;
  status: 'available' | 'unavailable';
  fetchedAtMs: number;
  points?: number;
  sourceUrl?: string;
}

export interface PublicHistoryIdentity {
  kind: 'github' | 'domain';
  claim: string;
  status: 'available' | 'unavailable';
  fetchedAtMs: number;
  identityId?: string;
  createdAtMs?: number;
  followers?: number;
  followersFetchedAtMs?: number;
  projects?: GithubProjectHistory[];
  truncated?: boolean;
  source?: string;
  thirdPartyRank?: ThirdPartyRank;
}

export interface ExternalHistoryEvidence {
  version: 1 | 2 | 3;
  identities: PublicHistoryIdentity[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface ThirdPartyRankingProvider {
  readonly name: string;
  readonly kinds: ReadonlyArray<'github' | 'domain'>;
  readonly defaultMaxPoints: number;
  rank(claim: string, getJson: (url: string) => Promise<unknown>, now: () => number): Promise<Omit<ThirdPartyRank, 'source'>>;
}

function makeHttpProvider(
  name: string, kinds: ReadonlyArray<'github' | 'domain'>, defaultMaxPoints: number,
  urlFor: (claim: string) => string, parse: (body: Record<string, unknown>, maxPoints: number) => number | undefined,
): ThirdPartyRankingProvider {
  return {
    name, kinds, defaultMaxPoints,
    async rank(claim, getJson, now) {
      const sourceUrl = httpsUrl(urlFor(claim));
      if (!sourceUrl) return { status: 'unavailable', fetchedAtMs: now() };
      try {
        const points = parse(record(await getJson(sourceUrl)), defaultMaxPoints);
        return { status: points === undefined ? 'unavailable' : 'available', fetchedAtMs: now(), points, sourceUrl };
      } catch {
        return { status: 'unavailable', fetchedAtMs: now(), sourceUrl };
      }
    },
  };
}

export const ghfindProvider: ThirdPartyRankingProvider = makeHttpProvider(
  'ghfind', ['github'], 30,
  (claim) => `https://ghfind.com/api/score/${claim}`,
  (body) => typeof body.final_score === 'number' && Number.isFinite(body.final_score)
    ? Math.max(0, Math.min(100, Math.round(body.final_score))) : undefined,
);

const TRANCO_TOP_RANK = 5_000_000;

export const trancoProvider: ThirdPartyRankingProvider = makeHttpProvider(
  'tranco', ['domain'], 12,
  (claim) => `https://tranco-list.eu/api/ranks/domain/${claim}`,
  (body, maxPoints) => {
    const entries = record(body.roaster).ranks;
    const rank = (Array.isArray(entries) ? entries : []).map(record).map((entry) => entry.rank)
      .find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value));
    if (rank === undefined) return undefined;
    if (rank >= TRANCO_TOP_RANK) return 0;
    // Higher rank number = less traffic; log-scale so most-visited domains earn the most credit.
    return Math.log(TRANCO_TOP_RANK / Math.max(1, rank)) / Math.log(TRANCO_TOP_RANK) * maxPoints;
  },
);

export const DEFAULT_THIRD_PARTY_RANKING_PROVIDERS: ReadonlyArray<ThirdPartyRankingProvider> = [ghfindProvider, trancoProvider];

export interface ThirdPartyRankingConfig {
  /** Active provider registry. Default: ghfind + tranco. Replace to add/remove sources. */
  providers?: ReadonlyArray<ThirdPartyRankingProvider>;
  /** Per-provider opt-out by name, in addition to the ANTSEED_RANK_<NAME> env switches. */
  disabled?: ReadonlyArray<string>;
}

function timestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function id(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class ExternalHistoryCollector {
  private cache = new Map<string, { expiresAt: number; result: Promise<PublicHistoryIdentity> }>();
  private bootstrap: { expiresAt: number; result: Promise<unknown> } | undefined;
  private readonly ranking: Required<Pick<ThirdPartyRankingConfig, 'providers'>> & Pick<ThirdPartyRankingConfig, 'disabled'>;

  constructor(private readonly getJson = fetchPublicJson, private readonly now = Date.now, ranking: ThirdPartyRankingConfig = {}) {
    this.ranking = { providers: ranking.providers ?? DEFAULT_THIRD_PARTY_RANKING_PROVIDERS, disabled: ranking.disabled };
  }

  async collect(results: PeerVerificationResults): Promise<ExternalHistoryEvidence> {
    const claims = new Map<string, { kind: 'github' | 'domain'; claim: string }>();
    for (const result of results.github) {
      if (result.verified && /^[a-z0-9-]{1,39}$/i.test(result.username)) {
        const claim = result.username.toLowerCase();
        claims.set(`github:${claim}`, { kind: 'github', claim });
      }
    }
    for (const result of results.domains) {
      if (result.verified && /^[a-z0-9.-]{1,253}$/i.test(result.domain)) {
        const claim = result.domain.toLowerCase();
        claims.set(`domain:${claim}`, { kind: 'domain', claim });
      }
    }
    const identities: PublicHistoryIdentity[] = [];
    for (const [claimKey, { kind, claim }] of [...claims].slice(0, MAX_IDENTITIES)) {
      let account: Record<string, unknown> | undefined;
      if (kind === 'github') {
        try {
          account = record(await this.getJson(`https://api.github.com/users/${claim}`));
          if (!id(account.id) || typeof account.login !== 'string' || account.login.toLowerCase() !== claim
            || !Number.isFinite(timestamp(account.created_at))) throw new Error('Invalid account');
        } catch {
          identities.push({ kind, claim, status: 'unavailable', fetchedAtMs: this.now() });
          continue;
        }
      }
      const accountFetchedAtMs = this.now();
      const followers = typeof account?.followers === 'number' && Number.isSafeInteger(account.followers) && account.followers >= 0
        ? account.followers : undefined;
      const key = account ? `github:${account.id}` : claimKey;
      let cached = this.cache.get(key);
      if (!cached || cached.expiresAt <= this.now()) {
        const result = this.load(kind, claim, account);
        cached = { expiresAt: this.now() + RETRY_MS, result };
        if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, cached);
        const entry = cached;
        void result.then((evidence) => { entry.expiresAt = evidence.fetchedAtMs + (evidence.status === 'available' ? EXTERNAL_HISTORY_TTL_MS : RETRY_MS); });
      }
      identities.push({ ...await cached.result, claim,
        ...(account ? { followers, followersFetchedAtMs: followers === undefined ? undefined : accountFetchedAtMs } : {}),
      });
    }
    return { version: EXTERNAL_HISTORY_VERSION, identities };
  }

  private async load(kind: 'github' | 'domain', claim: string, account?: Record<string, unknown>): Promise<PublicHistoryIdentity> {
    try {
      const evidence = kind === 'github' ? await this.github(claim, account!) : await this.domain(claim);
      const thirdPartyRank = await this.thirdPartyRank(kind, claim);
      return { ...evidence, kind, claim, status: 'available', fetchedAtMs: this.now(),
        ...(thirdPartyRank ? { thirdPartyRank } : {}) };
    } catch {
      return { kind, claim, status: 'unavailable', fetchedAtMs: this.now() };
    }
  }

  private async thirdPartyRank(kind: 'github' | 'domain', claim: string): Promise<ThirdPartyRank | undefined> {
    const disabled = new Set(this.ranking.disabled ?? []);
    const provider = this.ranking.providers.find((entry) => entry.kinds.includes(kind) && !disabled.has(entry.name) && !disabledByEnv(entry.name));
    if (!provider) return undefined;
    const rank = await provider.rank(claim, this.getJson, this.now);
    return { source: provider.name, ...rank };
  }

  private async github(claim: string, account: Record<string, unknown>): Promise<Partial<PublicHistoryIdentity>> {
    const source = `https://api.github.com/users/${claim}`;
    const projects = new Map<number, GithubProjectHistory>();
    let truncated = false;
    for (let page = 1; page <= 4; page++) {
      const data = await this.getJson(`https://api.github.com/users/${claim}/repos?per_page=100&page=${page}&sort=created&direction=asc`);
      if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid repository page');
      for (const value of data) {
        const repo = record(value);
        if (record(repo.owner).id !== account.id || repo.fork !== false || !id(repo.id)
          || typeof repo.size !== 'number' || !Number.isFinite(repo.size) || repo.size <= 0 || repo.disabled === true
          || typeof repo.name !== 'string' || !Number.isFinite(timestamp(repo.created_at))
          || typeof repo.stargazers_count !== 'number' || !Number.isSafeInteger(repo.stargazers_count)
          || repo.stargazers_count < 0 || typeof repo.archived !== 'boolean') continue;
        projects.set(repo.id, { id: repo.id, name: repo.name, createdAtMs: timestamp(repo.created_at),
          stars: repo.stargazers_count, archived: repo.archived });
      }
      truncated = data.length === 100;
      if (!truncated) break;
    }
    return { identityId: `github:${account.id}`, createdAtMs: timestamp(account.created_at), projects: [...projects.values()], truncated, source };
  }

  private async domain(claim: string): Promise<Partial<PublicHistoryIdentity>> {
    if (!this.bootstrap || this.bootstrap.expiresAt <= this.now()) {
      this.bootstrap = { expiresAt: this.now() + RETRY_MS, result: this.getJson('https://data.iana.org/rdap/dns.json') };
    }
    const services = record(await this.bootstrap.result).services;
    if (!Array.isArray(services)) throw new Error('Invalid RDAP bootstrap');
    const tld = claim.split('.').at(-1);
    const service = services.find((entry: unknown) => Array.isArray(entry) && Array.isArray(entry[0]) && entry[0].includes(tld));
    if (!Array.isArray(service) || !Array.isArray(service[1])) throw new Error('No authoritative RDAP service');
    const base = service[1].find((value: unknown) => typeof value === 'string' && value.startsWith('https://'));
    if (typeof base !== 'string') throw new Error('No HTTPS RDAP service');
    const url = publicHttpsUrl(base);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/domain/${encodeURIComponent(claim)}`;
    url.search = '';
    url.hash = '';
    const domain = record(await this.getJson(url.href));
    if (domain.objectClassName !== 'domain' || typeof domain.ldhName !== 'string' || domain.ldhName.toLowerCase() !== claim) {
      throw new Error('RDAP registration does not match verified domain');
    }
    const events = Array.isArray(domain.events) ? domain.events : [];
    const dates = events.map(record).filter((event) => event.eventAction === 'registration').map((event) => timestamp(event.eventDate));
    if (dates.length !== 1 || !Number.isFinite(dates[0])) throw new Error('Missing unambiguous registration');
    return { identityId: `domain:${claim}`, createdAtMs: dates[0], source: url.href };
  }
}

export interface ExternalHistoryPolicy {
  maxGithubPoints: number;
  maxFollowerPoints?: number;
  maxDomainPoints: number;
  maxAgeMs: number;
}

export const DEFAULT_EXTERNAL_HISTORY_POLICY: Readonly<ExternalHistoryPolicy> = {
  maxGithubPoints: 70, maxFollowerPoints: 20, maxDomainPoints: 12, maxAgeMs: EXTERNAL_HISTORY_TTL_MS,
};

export function scoreExternalHistory(peer: Pick<PeerInfo, 'peerId' | 'metadata' | 'verificationResults'>, nowMs = Date.now(), policy = DEFAULT_EXTERNAL_HISTORY_POLICY, ranking: ThirdPartyRankingConfig = {}) {
  const results = peer.verificationResults;
  const evidence = results?.externalHistory;
  const breakdown: { identityId: string; points: number; projectPoints: number; agePoints: number; followerPoints: number; providerScore?: ThirdPartyRank; providerPoints?: number }[] = [];
  const limit = (value: number, max: number) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
  const fresh = (time: number) => Number.isFinite(time) && time <= nowMs && nowMs - time <= limit(policy.maxAgeMs, EXTERNAL_HISTORY_TTL_MS);
  if (!results || !fresh(results.checkedAtMs) || !Array.isArray(results.github) || !Array.isArray(results.domains)
    || (evidence?.version !== 1 && evidence?.version !== 2 && evidence?.version !== EXTERNAL_HISTORY_VERSION) || !Array.isArray(evidence.identities)) {
    return { version: EXTERNAL_HISTORY_VERSION, points: 0, followerPoints: 0, breakdown };
  }
  const disabled = new Set(ranking.disabled ?? []);
  const providersByName = new Map((ranking.providers ?? DEFAULT_THIRD_PARTY_RANKING_PROVIDERS)
    .filter((provider) => !disabled.has(provider.name) && !disabledByEnv(provider.name)).map((provider) => [provider.name, provider]));
  const thirdPartyPoints = (item: PublicHistoryIdentity, cap: number) => {
    const rank = item.thirdPartyRank;
    if (evidence?.version !== 3 || !rank || rank.status !== 'available' || !fresh(rank.fetchedAtMs)) return undefined;
    const provider = providersByName.get(rank.source);
    if (!provider || !provider.kinds.includes(item.kind)) return undefined;
    const raw = typeof rank.points === 'number' && Number.isFinite(rank.points) && rank.points >= 0 ? rank.points : undefined;
    const providerPoints = raw === undefined ? 0 : Math.min(limit(provider.defaultMaxPoints, cap), raw);
    return providerPoints > 0 ? { providerScore: rank, providerPoints } : undefined;
  };
  const years = (time: number) => Number.isFinite(time) && time > 0 && time <= nowMs ? (nowMs - time) / (365.25 * 86_400_000) : 0;
  const seen = new Set<string>();
  for (const item of evidence.identities.slice(0, MAX_IDENTITIES)) {
    if (!item || item.status !== 'available' || !fresh(item.fetchedAtMs) || !item.identityId || seen.has(item.identityId)) continue;
    let points = 0;
    let projectPoints = 0;
    let agePoints = 0;
    let followerPoints = 0;
    let providerScore: ThirdPartyRank | undefined;
    let providerPoints = 0;
    if (item.kind === 'github' && /^github:[1-9]\d*$/.test(item.identityId)
      && results.github.some((result) => result?.verified && result.peerId === peer.peerId && typeof result.username === 'string' && result.username.toLowerCase() === item.claim && fresh(result.checkedAtMs))
      && (!peer.metadata?.verifications || (Array.isArray(peer.metadata.verifications.github) && peer.metadata.verifications.github.some((claim) => typeof claim?.username === 'string' && claim.username.toLowerCase() === item.claim)))) {
      const projects = Array.isArray(item.projects) ? item.projects.slice(0, 400) : [];
      const repoIds = new Set<number>();
      let oldestYears = 0;
      let starWeight = 0;
      let projectWeight = 0;
      for (const project of projects) {
        if (!project || !id(project.id) || repoIds.has(project.id) || !Number.isFinite(project.stars) || project.stars < 5
          || typeof project.name !== 'string' || typeof project.archived !== 'boolean'
          || results.github.some((result) => typeof result?.username === 'string' && result.username.toLowerCase() === item.claim && typeof result.repository === 'string' && result.repository.toLowerCase() === project.name.toLowerCase())
          || project.createdAtMs < (item.createdAtMs ?? Infinity) || years(project.createdAtMs) < 0.25) continue;
        repoIds.add(project.id);
        const weight = project.archived ? 0.2 : 1;
        starWeight += Math.log2(1 + Math.min(500, project.stars)) * weight;
        projectWeight += weight;
        oldestYears = Math.max(oldestYears, years(project.createdAtMs) * weight);
      }
      projectPoints = 40 * Math.min(1, starWeight / 40) + 20 * Math.min(1, projectWeight / 8);
      agePoints = projectWeight > 0 ? 10 * Math.min(1, oldestYears / 3) : 0;
      const githubCap = limit(policy.maxGithubPoints, 70);
      if (evidence.version >= 2 && typeof item.followers === 'number'
        && Number.isSafeInteger(item.followers) && item.followers >= 0 && fresh(item.followersFetchedAtMs ?? NaN)) {
        const ageGate = limit((years(item.createdAtMs ?? NaN) - 0.25) / 0.75, 1);
        const recognition = Math.log1p(Math.min(1_000, item.followers)) / Math.log1p(1_000);
        followerPoints = Math.min(limit(policy.maxFollowerPoints ?? 20, 20) * recognition * ageGate,
          Math.max(0, githubCap - projectPoints - agePoints));
      }
      const ranked = thirdPartyPoints(item, Math.max(0, githubCap - projectPoints - agePoints - followerPoints));
      if (ranked) {
        providerScore = ranked.providerScore;
        providerPoints = ranked.providerPoints;
      }
      points = Math.min(githubCap, projectPoints + agePoints + followerPoints + providerPoints);
    } else if (item.kind === 'domain' && item.identityId === `domain:${item.claim}`
      && results.domains.some((result) => result?.verified && result.peerId === peer.peerId && typeof result.domain === 'string' && result.domain.toLowerCase() === item.claim && fresh(result.checkedAtMs))
      && (!peer.metadata?.verifications || (Array.isArray(peer.metadata.verifications.domains) && peer.metadata.verifications.domains.some((claim) => typeof claim?.domain === 'string' && claim.domain.toLowerCase() === item.claim)))) {
      const domainCap = limit(policy.maxDomainPoints, 12);
      agePoints = domainCap * Math.min(1, years(item.createdAtMs ?? NaN) / 5);
      const ranked = thirdPartyPoints(item, Math.max(0, domainCap - agePoints));
      if (ranked) {
        providerScore = ranked.providerScore;
        providerPoints = ranked.providerPoints;
      }
      points = Math.min(domainCap, agePoints + providerPoints);
    } else continue;
    seen.add(item.identityId);
    breakdown.push({ identityId: item.identityId, points, projectPoints, agePoints, followerPoints,
      ...(providerScore ? { providerScore } : {}), ...(providerPoints > 0 ? { providerPoints } : {}) });
  }
  const strongest = breakdown.reduce<(typeof breakdown)[number] | undefined>((best, entry) => !best || entry.points > best.points ? entry : best, undefined);
  return { version: EXTERNAL_HISTORY_VERSION, points: strongest?.points ?? 0, followerPoints: strongest?.followerPoints ?? 0, breakdown };
}
