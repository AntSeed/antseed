# Buyer-local public-history reputation (version 3)

External history is a permissionless bootstrap signal, not an endorsement of a
provider's service correctness. There is no seller allowlist, brand-name lookup,
AntSeed approval, mandatory API credential, or central reputation service.
Display names never select an external identity. Only successfully verified
domain/GitHub ownership claims are eligible for collection.

## Composition

`routingReputationBreakdown(peer, now, policy)` separates:

- `rawChainScore`: the existing volume/maturity/stake/recency/ghost/risk score,
  **without** the old ownership bonus;
- `legacyChainScore`: a buyer-local cached chain score/trust fallback, only when
  full chain inputs are absent (older consumers and persisted rows);
- `external`: versioned per-identity points, split into project, age, and follower points;
- `failureGate`: `(1 - risk) * (channels + 1) / (channels + 1 + 2.5 * ghosts)`;
- `externalScore`: strongest external identity's points multiplied by that gate;
- `externalFollowerScore`: the follower portion of that same identity's credit,
  after the overall cap and failure gate; it is included in `externalScore`, not
  added a second time;
- `externalProviderScore`: the third-party rank portion of that same identity's
  credit, after the overall cap and failure gate; it is included in
  `externalScore`, not added a second time;
- `effectiveReputationScore`: the larger of raw chain and penalized external
  reputation, bounded to 100. A legacy fallback is also failure-gated.

The strongest external history can establish a **70-point** bootstrap score,
including with no settled channels. This can clear the desktop's default
60-point trust threshold, but never overrides blocked-peer rules, cooldowns,
request failure accounting, service compatibility, price limits, or existing
cached-input pricing penalties. A strong chain record is not reduced merely
because public data is unavailable. Seller-reported `reputationScore` is not a
routing authority.

DefaultRouter remains price-first among eligible peers. CLI model routing retains
its existing Price + Trust ranking. Router-local retains router-core's existing
explicit weighted scoring policy and reliability factor.

## GitHub calibration

Each verified username is resolved against GitHub's public account API. Numeric
account IDs key the portfolio cache; account lookup is repeated on a new
verification pass so a reassigned username cannot inherit the old account's
cached history. Repository owner IDs must match. Duplicate account/repository IDs
do not multiply points, including when several peer keys verify one account.

Only non-fork, non-empty, non-disabled repositories are collected for original
project credit. The scoring pass also excludes the verification repositories
named in this peer's proofs, projects less than three months old, and projects
with fewer than five stars. For each remaining project:

- archived weight is 0.2; otherwise weight is 1;
- star contribution is `log2(1 + min(stars, 500)) * weight`;
- project-count contribution is its weight.

Portfolio points are:

`40 * min(starContributions / 40, 1)`

`+ 20 * min(projectContributions / 8, 1)`

`+ 10 * min(oldestEligibleProjectYears / 3, 1)`.

Archived projects' age contribution is also multiplied by 0.2. The configured
GitHub cap is applied afterward. Account creation time is recorded and prevents
credit for projects predating the account, but account age alone earns **zero**.
The latest push is not used. Repository age and stars do **not** establish
sustained maintenance, current-owner tenure, originality of code, or service
quality. Commit-history/maintenance verification is not implemented.

Synthetic calibration tests (not brand fixtures): ten mature original projects
with 100 stars each earn 70; eight nine-month-old projects with 25 stars each earn
about 60; without followers, an old empty account, a zero-star proof-only account, and a fresh
zero-star portfolio earn zero GitHub credit. One huge-star repository is bounded
below 25 points, and an entirely archived ten-project portfolio remains below 25.

## GitHub followers

Version 2 also records `followers` from the verified account's existing public
API lookup. This is the number of people following the account, not the number
of repositories it has starred. No follower-list crawling, new HTTP requests,
or API credentials are required. Numeric ID resolution still binds the count to
the verified account, not its display name or a previously assigned username.

The candidate contribution is:

`maxFollowerPoints * log(1 + min(followers, 1000)) / log(1001) * ageGate`

where `maxFollowerPoints` defaults to 20 and
`ageGate = clamp((accountYears - 0.25) / 0.75, 0, 1)`.

Accounts at most three months old get no follower credit; eligibility increases
linearly to full credit at one year. A mature account with 261 followers earns
about 16.1 points; 1,000 or more followers earn at most 20. Counts must be finite,
nonnegative safe integers. Missing, malformed, future-dated, or stale observations
earn zero follower points. Account age alone still earns zero.

Follower credit does not require owning a qualifying repository: a developer may
be recognized for work in other organizations. A follower-only profile can earn
at most 20 points, never reach the default 60-point routing threshold by this
signal alone, and remains subject to the existing failure/risk gates.

Followers are added to project/history credit **within** the existing 70-point
GitHub ceiling. The breakdown reports only follower points that fit under that
ceiling; a portfolio already at 70 receives no additional points. The strongest
identity rule remains unchanged, so several verified accounts cannot stack
follower credit. Followers can be purchased or manipulated, and old accounts can
change hands: the age gate is a conservative limit, not proof of authenticity.
Verified upstream contributions remain a separate, unimplemented signal.

## Third-party ranking providers

Version 3 optionally consults independent third-party ranking services and
attaches their verdict to a verified identity as
`thirdPartyRank = { source, status, fetchedAtMs, points?, sourceUrl? }`. These
are buyer-local, additive sub-scores: they run in the same background
collection pass, reuse the same safe HTTPS transport, and are never a routing
authority on their own. Providers are a pluggable registry; each implements

```
interface ThirdPartyRankingProvider {
  name: string;                        // e.g. "ghfind"
  kinds: ('github' | 'domain')[];      // which claims it can rank
  defaultMaxPoints: number;            // its contribution ceiling
  rank(claim, getJson, now): Promise<{ status, points?, sourceUrl? }>;
}
```

The default registry ships two providers:

- **ghfind** (`github`, up to 30 points): `https://ghfind.com/api/score/{username}`
  returns a 0–100 developer-reputation aggregate (`final_score`). No credential
  is required. GitHub *organization* logins are not scored by the service and
  remain `unavailable`.
- **Tranco** (`domain`, up to 12 points): `https://tranco-list.eu/api/ranks/domain/{domain}`
  returns the domain's position in the Tranco top-sites list. Rank is
  log-scaled so heavily trafficked domains earn the most, and unlisted domains
  earn nothing. A rank near the list floor (5,000,000) earns ~0.

Both are evidence of **popularity/recognition elsewhere**, not of AntSeed
service correctness, and both are applied **within** the existing per-identity
ceilings: ghfind points count toward the 70-point GitHub cap, Tranco points
toward the 12-point domain cap. A portfolio already at its ceiling receives no
third-party boost. Provider points that do not fit under the remaining
headroom are clamped, and the breakdown reports them as separate
`providerScore` / `providerPoints` fields.

Each provider is independently **opt-out** in two ways:

- per-process config: `ThirdPartyRankingConfig = { providers?, disabled? }`
  lets a router replace the registry entirely or skip provider names;
- per-provider environment switch: setting
  `ANTSEED_RANK_<PROVIDER_NAME>` to `0`, `false`, `off`, or `no` (case-
  insensitive) disables exactly that provider for both collection and scoring,
  e.g. `ANTSEED_RANK_GHFIND=0` or `ANTSEED_RANK_TRANCO=off`.

There is no global kill switch: defaults are conservative, requests are
bounded, and no provider is queried unless its claim kind matches and it is
not disabled. Naming one provider or several in `disabled` adds nothing to a
deny-list on disk and does not force a network round-trip.

## Domains and correlated evidence

The buyer retrieves IANA's RDAP DNS bootstrap and queries an advertised HTTPS
registry endpoint. A registration event is usable only when the authoritative
response's domain object has an **exact** matching `ldhName`. Missing, ambiguous,
redirected, or parent-only answers earn no age credit. Thus a proof for
`person.github.io` cannot inherit `github.io` registration age, and a proof for
`service.example.com` cannot inherit `example.com` age. Separately proving the
parent makes it a separate eligible claim, not an inferred one.

Registration age contributes up to 12 points over five years. It does not prove
current-owner tenure. Domain points and GitHub points are **not added**: the
maximum identity score is used. Duplicate claims, multiple domains, GitHub Pages
evidence, and multiple peer keys therefore cannot stack identity credit. This
does not prevent one organization from operating multiple peers; it prevents
counting those peers as independent reputation evidence.

## Collection, safety, and freshness

- Collection runs in the existing background verification queue, never on the
  request-serving path. At most two peers are enriched concurrently; each peer
  collects identities sequentially, with at most eight distinct claims per pass.
- GitHub uses at most five requests per identity: one account lookup and four
  pages of up to 100 repositories, oldest-first. Pagination truncation is
  recorded, plus one optional request to the matching third-party ranking
  provider when one is enabled. No extrapolation is made from unseen
  repositories.
- RDAP uses one shared cached bootstrap plus at most one registry query per
  domain, plus one optional request to the matching ranking provider.
  HTTP redirects are never followed, including during discovery.
- HTTPS connections require public hostnames, reject literals/credentials/custom
  ports, resolve IPv4 addresses, reject private/reserved answers, and pin the
  checked address for the TLS connection. IPv6-only destinations conservatively
  remain unavailable. DNS and response reads share an eight-second deadline.
- JSON responses are limited to 2 MB; ownership proof responses have a smaller
  limit and retain their existing proof-size validation. Compressed responses
  are rejected. No seller-supplied URL is used for GitHub API collection.
- The identity cache holds at most 512 entries. Successful public evidence is
  cached for seven days; failed portfolio/domain lookups retry after an hour.
  Each successful account lookup refreshes `followers` and its separate
  `followersFetchedAtMs`, including decreases, without extending the cached
  portfolio's timestamp. Invalid/missing counts clear follower credit rather
  than retaining a previously higher count. Follower observations must also be
  within the configured freshness window (at most seven days).
  Account-ID lookup is deliberately not bypassed by portfolio caching. IANA
  discovery is cached for one hour, including failures.
- Scoring requires fresh evidence **and** fresh successful ownership results,
  both within seven days, rejects future timestamps/unknown evidence versions,
  checks peer IDs and current claims when metadata is available, and treats
  `thirdPartyRank` older than seven days or in a disabled/unknown provider as
  zero. Failed public collection is `unavailable`, not failed ownership
  verification. Third-party ranks collected by older evidence versions are
  ignored until version 3.

The unauthenticated GitHub quota can limit large discovery sweeps. Partial
pagination, API outages, unavailable RDAP, IPv6-only hosts, and absent public
projects can all under-credit legitimate providers. Stars can be manipulated;
accounts, domains, and projects can change hands. Public history is a heuristic
prior, not proof of correct inference. Marketplace adapters and authenticated
GitHub collection are intentionally deferred.

## Persistence, API, and configuration

Evidence is stored only in buyer-local
`verificationResults.externalHistory = { version: 3, identities: [...] }`.
It is not encoded in signed seller metadata, so no wire metadata version bump is
needed. Buyer state preserves it through the existing verification-results
round-trip. Versions 1–2 evidence retain their project/domain/follower credit
and earn no third-party rank credit until refreshed; unknown/absent evidence
versions earn no external points. The routing-breakdown envelope stays at
version 1, with additive `externalFollowerScore` / `externalProviderScore`
fields; its nested external score is version 3. Scores are
recomputed from evidence instead of accepting persisted external scores.

Buyer state additionally publishes `reputationBreakdown`. The CLI model catalog
computes effective routing scores, the desktop catalog consumes those scores,
and desktop Discover rows carry the separate breakdown. Raw chain display fields
are not overwritten by the external score. Seller score tooltips explain chain
versus public-history credit and identify the included follower contribution;
reputation filters and chat warnings use the
effective score. Older chain-score-only records retain
an explicitly distinguishable legacy fallback. The legacy exported
`computeOnChainScore` / `computeOnChainReputationScore` APIs retain their old
ownership-bonus behavior for compatibility; production routing uses
`computeRoutingReputationScore` instead.

`ExternalHistoryPolicy` exposes `maxGithubPoints`, `maxDomainPoints`, `maxAgeMs`,
and optional `maxFollowerPoints` (default 20, preserving older policy objects).
Pass it to the scoring functions, `DefaultRouter`/`LocalRouter` constructors, or
router-core's scoring context. Caps cannot exceed the safety ceilings
(70 GitHub / 12 domain / 20 follower points / seven days). Set
`maxFollowerPoints` to zero to disable only follower credit, or both
`maxGithubPoints` and `maxDomainPoints` to zero to disable external credit.
The CLI/desktop use the defaults; there is no new settings UI.

`ThirdPartyRankingConfig` (on `NodeConfig.externalHistory.ranking`, the scoring
functions, and the router constructors) drives the third-party provider
registry. `providers` replaces the default ghfind+Tranco set with any other
registry of your own providers; `disabled` lists provider names to skip. The
same opt-out is available per-provider via the `ANTSEED_RANK_<NAME>` env var,
so a node operator can switch a source off without a config change. Both
filters are applied at collection time and again at scoring time, so evidence
gathered before an opt-out earns no points either.
