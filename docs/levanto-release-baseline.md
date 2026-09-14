# Levanto first-release schema baseline

Verified on September 14, 2026. This supersedes the earlier requirement to
support upgrades between unpublished Levanto routing schemas. It does not
remove compatibility with released AntSeed clients or payment databases.

## Evidence checked

- Refreshed `origin/main` from `https://github.com/AntSeed/antseed.git`:
  `22462fc3aac122c46f65df8cf24e8df04460ba69`, committed September 10, 2026.
- npm's latest `@antseed/node` is `0.2.118`, and `@antseed/protocol` is `0.1.4`.
  Downloaded both exact package tarballs using `npm pack`, without installing
  or running lifecycle scripts, and inspected their compiled code.
- npm's latest CLI is `@antseed/cli@0.1.158`.
- GitHub's latest non-prerelease is desktop tag `v0.2.38`, published
  September 1, 2026. Checked that tag's migration file list as well.

These checks identify main and published artifacts, not which versions every
live peer or desktop installation is currently running. No production runtime
inventory or deployment was performed.

## Consolidation boundary

| Area | Main / published SDK baseline | Decision |
| --- | --- | --- |
| Routing decision SQLite database | No routing migrations | Fold the unshipped routing 002 into routing 001; create the final schema directly |
| Payment channel SQLite database | Channel migrations 001–005 | Preserve these files unchanged; keep new reserve-recovery migration 006 as an additive upgrade |
| Metering / verification SQLite databases | Existing initial migrations | Leave unchanged |
| Discovery metadata | v12, including v11 image-unit pricing | Preserve published bytes and unit IDs; do not renumber or squash wire versions |
| Per-call pricing | No `successful_requests` unit | Introduce it once, with no compatibility layer for earlier unshipped per-call drafts |

SQLite migration versions belong to separate databases. Combining routing 001
with channel 006 would not produce one global migration: it would break the
independent initialization and upgrade paths.

The final routing 001 includes nullable observed cost and CQT, optional forecast
columns, `cost_source`, `router_metadata`, and both routing indexes. It no longer
creates an intermediate table, copies rows, drops the table, or renames a v2
replacement. Published payment-channel rows, receipts, signatures, service
totals, and migration history remain intact when channel 006 runs.

## Discovery safety

Image-unit ID 0 retains its existing float32 price encoding. The newly appended
`successful_requests` unit uses uint32 micro-USDC for exact fixed fees. No
additional wire-version bump is introduced for this previously unpublished unit.

The released SDK decoder rejects unknown unit IDs. Executing the downloaded
SDK 0.2.118 decoder with protocol 0.1.4 against a new per-call advertisement
confirmed `Unsupported service unit billing component unit`. Thus an older
client cannot use that advertisement; it does not see a zero-token-price free
service. This rejects the advertisement as a whole, not just one service in a
mixed catalog. Buyers of per-call routing services need an updated SDK.

Both metadata signing and encoding now reject nonempty unit-billing definitions
when targeting metadata versions below 11. The old behavior silently omitted
the definitions. Token-only metadata remains supported at those older versions.

`tests/released-discovery-baseline.test.ts` pins an image advertisement generated
by the published SDK 0.2.118 and protocol 0.1.4 encoders. Its fixture uses v12,
peer ID `aa` repeated 20 times, signature `bb` repeated 65 times, region `test`,
timestamp `1700000000000`, one provider/service named `image`, zero token rates,
an unconditional `openai-images` output-image fee of USD 0.25, concurrency 1,
and load 0. Both complete bytes and signing bytes must remain identical.

## Local alpha databases

No upgrade path from the obsolete unpublished routing 001 schema is retained.
Use a fresh alpha data directory when testing the consolidated schema. If
reusing a directory, stop the app/node first and archive the routing history
database `routing-decisions.db` together with any `-wal` and `-shm` sidecars
before allowing the app to create a fresh routing database. Old alpha routing
history is not imported automatically.

Do not delete or reset payment-channel databases, keys, authorizations, or other
application data. This change does not delete any local databases automatically.

## Validation

- Routing tests cover final-schema initialization in exactly one migration,
  nullable telemetry, defaults, indexes, row preservation on reopen, and retention.
- A channel upgrade test starts from the published v5 schema and verifies that
  only migration 006 is added, preserving payment records and signatures.
- Discovery tests pin published image bytes, reject lossy downgrades, and retain
  older token-only metadata support.
- Focused migration/discovery suites: 50 tests passed.
- Full SDK suite: 1,149 tests passed across 101 files; SDK build passed.
- The downloaded published decoder was additionally exercised against a new
  per-call advertisement and rejected its unknown billing unit as expected.

No unpublished Levanto-to-Levanto schema compatibility matrix is required.
This is a source/schema consolidation, not a rewrite of the prior git commits.
