# Buyer-local public-history reputation (version 1)

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
- `external`: versioned per-identity points, split into project and age points;
- `failureGate`: `(1 - risk) * (channels + 1) / (channels + 1 + 2.5 * ghosts)`;
- `externalScore`: strongest external identity's points multiplied by that gate;
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
quality. Commit-history/maintenance verification is not implemented in v1.

Synthetic calibration tests (not brand fixtures): ten mature original projects
with 100 stars each earn 70; eight nine-month-old projects with 25 stars each earn
about 60; an old empty account, a zero-star proof-only account, and a fresh
zero-star portfolio earn zero GitHub credit. One huge-star repository is bounded
below 25 points, and an entirely archived ten-project portfolio remains below 25.

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
  recorded. No extrapolation is made from unseen repositories.
- RDAP uses one shared cached bootstrap plus at most one registry query per
  domain. HTTP redirects are never followed, including during discovery.
- HTTPS connections require public hostnames, reject literals/credentials/custom
  ports, resolve IPv4 addresses, reject private/reserved answers, and pin the
  checked address for the TLS connection. IPv6-only destinations conservatively
  remain unavailable. DNS and response reads share an eight-second deadline.
- JSON responses are limited to 2 MB; ownership proof responses have a smaller
  limit and retain their existing proof-size validation. Compressed responses
  are rejected. No seller-supplied URL is used for GitHub API collection.
- The identity cache holds at most 512 entries. Successful public evidence is
  cached for seven days; failed portfolio/domain lookups retry after an hour.
  Account-ID lookup is deliberately not bypassed by portfolio caching. IANA
  discovery is cached for one hour, including failures.
- Scoring requires fresh evidence **and** fresh successful ownership results,
  both within seven days, rejects future timestamps/unknown evidence versions,
  and checks peer IDs and current claims when metadata is available. Failed
  public collection is `unavailable`, not failed ownership verification.

The unauthenticated GitHub quota can limit large discovery sweeps. Partial
pagination, API outages, unavailable RDAP, IPv6-only hosts, and absent public
projects can all under-credit legitimate providers. Stars can be manipulated;
accounts, domains, and projects can change hands. Public history is a heuristic
prior, not proof of correct inference. Marketplace adapters and authenticated
GitHub collection are intentionally deferred.

## Persistence, API, and configuration

Evidence is stored only in buyer-local
`verificationResults.externalHistory = { version: 1, identities: [...] }`.
It is not encoded in signed seller metadata, so no wire metadata version bump is
needed. Buyer state preserves it through the existing verification-results
round-trip; unknown/absent evidence versions earn no external points. Scores are
recomputed from evidence instead of accepting persisted external scores.

Buyer state additionally publishes `reputationBreakdown`. The CLI model catalog
computes effective routing scores, the desktop catalog consumes those scores,
and desktop Discover rows carry the separate breakdown. Raw chain display fields
are not overwritten by the external score. Seller score tooltips explain chain
versus public-history credit; reputation filters and chat warnings use the
effective score. Older chain-score-only records retain
an explicitly distinguishable legacy fallback. The legacy exported
`computeOnChainScore` / `computeOnChainReputationScore` APIs retain their old
ownership-bonus behavior for compatibility; production routing uses
`computeRoutingReputationScore` instead.

`ExternalHistoryPolicy` exposes `maxGithubPoints`, `maxDomainPoints`, and
`maxAgeMs`. Pass it to the scoring functions, `DefaultRouter`/`LocalRouter`
constructors, or router-core's scoring context. Caps cannot exceed v1's safety
ceilings (70/12/seven days); setting both point caps to zero disables external
credit. The CLI/desktop use the defaults; there is no new settings UI in v1.
