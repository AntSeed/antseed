---
name: publish
description: Publish AntSeed packages to npm, including version bumping, dry-run validation, and verification.
---

# Publish AntSeed Packages to npm

Publish all public `@antseed/*` packages to the npm registry. This skill handles version bumping, building, publishing, and verification.

## Prerequisites

- Must be logged in to npm (`npm whoami` should return the org owner)
- Working directory must be the monorepo root `/Users/shahafan/Development/antseed`
- All changes should be committed before publishing

## Workflow

### 1. Determine scope and version bump

**Scope** — decide whether to publish all packages or only what's needed:
- **Full release**: bump and publish every public package together. Use this for coordinated feature releases or when you genuinely don't know which packages changed.
- **Selective release**: bump and publish only the packages whose runtime behavior changed *plus* their pinned dependents on npm. Use this for targeted bug fixes (e.g. a fix in `@antseed/api-adapter` that needs to reach the seller stack).

To compute the minimum publish set for a selective release:

1. Identify the package(s) where the fix actually lives (the "source" set).
2. For each candidate dependent (anything that imports the source package), inspect its **published** dependency pin: `npm view <pkg>@latest dependencies`. Workspace `workspace:*` refs are resolved at publish time to **exact** versions (no caret), so the published dependent will keep installing the old source forever unless it's republished too.
3. Add every dependent whose published pin is exact to the publish set, recursively. Stop at packages that declare the source as a peer dep with a `>=` range (those don't need rebumping).

Example — a fix in `@antseed/api-adapter`:

```bash
npm view @antseed/node@latest dependencies | grep api-adapter
# '@antseed/api-adapter': '0.1.36'   ← exact pin, must republish node
npm view @antseed/cli@latest dependencies | grep -E "api-adapter|@antseed/node"
# '@antseed/api-adapter': '0.1.36'
# '@antseed/node': '0.2.75'          ← exact pin, must republish cli
```

→ Minimum set: `api-adapter`, `node`, `cli`. Other workspace consumers (`provider-core`, `router-core`, `ant-agent`) declare `@antseed/node >=0.1.0` and don't need republishing.

**Version bump** — ask the user what kind:
- **patch** (0.1.1 -> 0.1.2) — bug fixes, packaging fixes
- **minor** (0.1.2 -> 0.2.0) — new features, non-breaking changes
- **major** (0.2.0 -> 1.0.0) — breaking changes

### 2. Bump versions

Use pnpm to bump versions in a single command. **Never edit each package.json manually.**

#### Selective bump (recommended for bug fixes)

Pass each package explicitly:

```bash
pnpm --filter @antseed/api-adapter \
     --filter @antseed/node \
     --filter @antseed/cli \
  exec npm version <patch|minor|major> --no-git-tag-version
```

#### Full-release bump

```bash
# Bump all 15 publishable packages at once
pnpm -r --filter './packages/*' \
       --filter './plugins/*' \
       --filter '@antseed/cli' \
       --filter '@antseed/network-stats' \
       --filter '@antseed/payments' \
  exec npm version <patch|minor|major> --no-git-tag-version
```

This bumps everything under `packages/*` and `plugins/*`, plus the three publishable apps (`@antseed/cli`, `@antseed/network-stats`, `@antseed/payments`). Private packages (`e2e`, `@antseed/desktop`, `@antseed/website`, `@antseed/diem-staking`) are excluded.

Before running, sanity-check which apps are public vs private (the set occasionally changes):

```bash
for d in apps/*/; do node -e "const p=require('./$d/package.json'); console.log((p.private?'[PRIV]':'[PUB] ')+p.name+'@'+p.version)"; done
```

If a new public app appears, add it to the filter list above and update this skill.

Verify the bump worked:

```bash
pnpm -r --filter './packages/*' \
       --filter './plugins/*' \
       --filter '@antseed/cli' \
       --filter '@antseed/network-stats' \
       --filter '@antseed/payments' \
  exec -- node -p 'require("./package.json").name + "@" + require("./package.json").version'
```

### 3. Build all packages

```bash
pnpm run build
```

Build must succeed with zero errors before proceeding.

### 4. Dry-run publish

For a **selective release**, scope the publish to the same `--filter` set you bumped:

```bash
pnpm --filter @antseed/api-adapter \
     --filter @antseed/node \
     --filter @antseed/cli \
  publish --no-git-checks --access public --dry-run
```

For a **full release**, use `-r`:

```bash
pnpm -r publish --no-git-checks --access public --dry-run
```

Verify in the output:
- No `workspace:*` appears in any tarball's dependencies (pnpm resolves these automatically)
- All package versions match the bump target
- Each tarball only contains `dist/` files (not source `.ts` files)

### 5. Publish for real

Same `--filter` scope as the dry-run:

```bash
# selective
pnpm --filter <...> publish --no-git-checks --access public

# full
pnpm -r publish --no-git-checks --access public
```

Packages publish in dependency order. If a package version already exists on npm, pnpm skips it gracefully.

### 6. Verify installation

Test that the CLI installs cleanly from npm in an isolated temp directory:

```bash
tmpdir=$(mktemp -d) && cd "$tmpdir" && npm install @antseed/cli@<NEW_VERSION> 2>&1 && npx antseed --version && rm -rf "$tmpdir"
```

Confirm:
- `npm install` exits 0 with no workspace protocol errors
- `antseed --version` runs and prints a version

### 7. Commit the version bump

Stage all changed `package.json` files and the lockfile, then commit:

```
chore: bump all packages to v<NEW_VERSION>
```

## Important notes

- **Always use `pnpm publish`**, never `npm publish`. Only pnpm knows how to resolve `workspace:*` references to real version numbers in the published tarball.
- The root `package.json` has convenience scripts: `pnpm run publish:all` (build + publish) and `pnpm run publish:dry` (build + dry-run).
- The `e2e`, `@antseed/desktop`, `@antseed/website`, and `@antseed/diem-staking` packages are private and are automatically skipped.
- All publishable packages have `"files": ["dist"]` to keep tarballs clean.
- The `@antseed/node` package includes `"files": ["dist", "scripts"]` for the postinstall patch script.
- If the `pnpm run build` step fails inside `@antseed/desktop` (e.g. native-module rebuild OOM), it does NOT block publishing — desktop is private, and all publishable packages build in earlier tiers. Just confirm each publishable package has a fresh `dist/` before proceeding to dry-run.

## Publishable packages (for reference)

```
packages/*   @antseed/node, @antseed/api-adapter, @antseed/ant-agent,
             @antseed/provider-core, @antseed/router-core
plugins/*    provider-anthropic, provider-claude-code, provider-claude-oauth,
             provider-openai, provider-openai-responses, provider-local-llm,
             router-local
apps/*       @antseed/cli, @antseed/network-stats, @antseed/payments
```

Private (not published): `e2e`, `@antseed/desktop`, `@antseed/website`, `@antseed/diem-staking`.
