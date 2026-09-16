# Simplified router shipping handoff

September 16, 2026. Local implementation on `codex/levanto-p1-local`.
This document supersedes the initial P1/P2 routing-cadence and day-pass consent proposals.
It does not certify Levanto's private seller implementation or deploy anything.

## Shipping behavior

- Routing is disabled by default. Installing a plugin does not approve payments.
- A router chooses the initial model of a conversation. Later turns, context
  rewrites, and refresh headers do not invoke the classifier again.
- The selected model is persisted before the initial inference dispatch, so an
  inference failure does not itself trigger another paid classification on retry.
- Explicit advertised model selections and peer/model pins bypass classification.
  Same-model peer failover remains possible within buyer constraints. An unavailable
  chosen model does not silently authorize a different model or paid reclassification.
- Requests without a stable conversation identity are independent. Clients must
  provide their supported session identifier to receive conversation stickiness.
- Router recommendations must pass host-owned eligibility, pricing, trust,
  capability, timeout, and cancellation checks. Forecasts remain optional.
- Settings belong to each plugin's `routingSettingsSchema` and namespaced
  `routerSettings`. There is no shared cost/quality dial or shared `cqt` preference.
- Levanto is not added to the mandatory trusted plugin catalog. Its adapter remains
  a reference package in this worktree; generic package installation/loading remains.

## Three distinct concepts

1. **Router activation (config):** whether the selected plugin may route new
   conversations. This is not a payment receipt or spending approval.
2. **Access agreement (payment DB):** permission to buy a specific seller/service's
   exact price and duration on use. Activation itself authorizes no charge.
3. **Access purchase authorization (payment DB):** a signed full-period fee and its
   start time. This is not proof of seller acknowledgment or on-chain settlement.

An access pass is the product; a payment channel is the settlement mechanism.
Do not call the product a "bounded payment channel": the reserve ceiling, channel
deadline, and purchased access period are different limits. A channel can close
before access expires without implying a second purchase or a prorated refund.

The v1 discovery protocol still advertises `antseed-day-pass` and represents
**24-hour access**. Buyer agreement records use `durationSeconds`, but this is not
an implementation of arbitrary weekly/monthly offers. Supporting those requires
an explicit discovery contract and seller implementation, not just a UI rename.

## Purchase-on-use lifecycle

1. Discover the exact seller and service price. Missing, ambiguous, invalid, or
   failed discovery never substitutes a default dollar amount.
2. The user reviews and accepts the displayed price and duration once. The DB
   records an enabled agreement, scoped to chain, channel contract, buyer,
   seller, and service.
3. A routing request may establish or replay a reserve without buying access.
   A 402 alone does not authorize the access fee.
4. The adapter validates a successful, nonempty eligible classification. If the
   seller reports renewal due, the host may authorize one full access period.
5. During the authorized period, replay uses the original signed authorization
   and does not move its expiry. Route reuse does not invoke the classifier.
6. After expiry, the next eligible use may purchase one new period at unchanged
   approved terms. Idle days do not accumulate fees. There is no background renewal.
7. Any discovered price change, including a decrease, pauses new purchases until
   explicit reapproval. Returning to the old price does not silently re-enable them.
8. Disabling the router or pausing its agreement prevents new purchases. Existing
   signatures remain payable; pausing is not cancellation of already authorized debt.

The buyer period starts at `authorizedAtMs` and lasts 86,400 seconds. Levanto must
confirm that its seller grants the same rolling period; a seller-side UTC-midnight
expiry is **not** interchangeable. Until verified, treat this as a rollout blocker.

## Storage and signing protections

Channel migration 007 adds `access_agreements` and `access_purchases`; deployed
migrations 001–005 remain unchanged. Migration 006 remains the existing unpublished
routing support migration. Do not copy config consent into a paid agreement.

The SQLite immediate transaction rechecks enabled, matching terms, prior purchase,
period overlap, and exact channel authorization increment. It commits the purchase,
cumulative signature, and service totals together. A failure commits neither fee
nor purchase. Competing managers cannot purchase the same period twice. Agreements
and purchase history survive restarts and are independent of channel retirement.

The host signs at most one exact approved fee, within the confirmed reserve; an
insufficient reserve is not permission to prorate the price. Access and metered
usage must not share a seller channel. Service IDs are required for access signing.
Cancellation is checked before signing and again before persistence. Permission is
also checked transactionally after signing, before committing.

This does not create distributed exactly-once delivery. A crash after persistence
but before transmission can leave a locally authorized fee not yet received by the
seller. Same-channel retry replays the original proof. The private seller must
deduplicate it and preserve entitlements across channel replacement. The existing
transport flush delay is not an acknowledgment protocol.

## Activation interfaces

Desktop: choose an installed router, review the actual discovered access offer,
and select **Accept terms and enable**. **Review router access** reopens terms for
an already selected router. No quote means no paid activation. **Pause purchases**
pauses the agreement; selecting **None** disables routing.

CLI, with the buyer proxy running:

```sh
antseed buyer access status <sellerPeerId> <serviceId>
antseed buyer access activate <sellerPeerId> <serviceId> \
  --amount-micro-usdc <exact-discovered-price> --duration-seconds 86400
antseed buyer access pause <sellerPeerId> <serviceId>
```

Activation approves access terms only; CLI routing still requires the selected
router and `buyer.routingPreferences.routerEnabled: true`.

The native CLI and desktop main process share `/_antseed/access-billing`. GET
returns the quote, agreement, and last authorization. POST accepts `activate` or
`pause`; activation requires exact current terms. Requests from browser origins,
non-loopback Host headers, non-JSON writes, and oversized bodies are rejected.
This is a local-user control interface, not an authenticated remote billing API.

Plugin metadata uses `accessServiceId`. The optional `configureAccessSigning`
hook receives `(sellerPeerId, { purchase, signal }) => Promise<void>`.
`purchase: false` permits reserve/replay only; `purchase: true` requests a purchase
subject to host and DB checks. A plugin does not get a signing key. Plugins are
trusted installed code in this process, not a sandbox against malicious code.

## Other billing methods

Token-priced and fixed-per-call classifiers remain supported without a pass.
Per-call payment requires a parsed classification accepted by the host's eligible
candidate validator; malformed, empty, ineligible, failed, and cancelled responses
cannot authorize the fee. Reusing a decision costs no classifier fee. A new valid
classification costs one fee even if it selects the same model as another session;
a later inference failure does not refund valid classification work.

See `router-per-call-billing.md` for the exact micro-USDC contract. An invalid-200
seller can leave its channel payment gate blocked; the buyer refuses catch-up
payment rather than paying for an invalid response to restore availability.

## Verification and release gate

Regression coverage includes exact approvals, discovery failure, changed terms,
paused terms, reserve-only 402 handling, cancellation/revocation while signing,
multi-manager races, reopened SQLite storage, identity/domain isolation, channel
replacement, initial-model-only routing, explicit models, and concurrent initial
requests. Isolated Anvil fixtures exercise token/per-call authorization and real
settlement, including invalid classification and rejected catch-up fees.

Before production rollout:

- Verify the private seller's rolling access period, replay deduplication,
  entitlement persistence across restarts/channel closure, and renewal response.
- Exercise paid activation, pause, price change, and reapproval against that seller
  in desktop; local fixture success is not evidence for the private implementation.
- Rehearse a real buyer DB upgrade and keep a DB backup. Never remove payment
  authorization history when resetting router settings.
- Keep routing opt-in and roll out to a small cohort. Disabling routing prevents
  new classifier purchases but does not erase already signed spending obligations.

No PR, push, production release, or private-seller certification is performed by
this local implementation.

### Local validation results

- SDK: 1,176 tests passed; buyer-core: 11 passed; CLI: 554 passed;
  Levanto adapter: 108 passed; desktop config tests: 8 passed.
- Workspace typecheck, buyer-core/SDK/CLI/adapter builds, desktop main build,
  and desktop renderer typecheck passed.
- All three isolated-chain routing fixtures passed. The token fixture settled
  140 micro-USDC for one classification across four inference requests. Each
  per-call fixture settled 10,000 micro-USDC for two valid classifications;
  failed/invalid classifications and reuse did not add fees.
- Desktop renderer suite: 410 passed, with one pre-existing failure in
  `modules/routing/select.test.ts` ("a distant cooldown still counts as cooling
  down"). The cooldown implementation/test are not changed by this work.
- Desktop activation against Levanto's private seller is not validated here.
