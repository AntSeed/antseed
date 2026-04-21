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

### 1. Determine version bump

Ask the user what kind of version bump they want:
- **patch** (0.1.1 -> 0.1.2) — bug fixes, packaging fixes
- **minor** (0.1.2 -> 0.2.0) — new features, non-breaking changes
- **major** (0.2.0 -> 1.0.0) — breaking changes

### 2. Bump all package versions at once

Use pnpm to bump all publishable workspace package versions in a single command. **Never edit each package.json manually.**

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

```bash
pnpm -r publish --no-git-checks --access public --dry-run
```

Verify in the output:
- No `workspace:*` appears in any tarball's dependencies (pnpm resolves these automatically)
- All package versions match the bump target
- Each tarball only contains `dist/` files (not source `.ts` files)

### 5. Publish for real

```bash
pnpm -r publish --no-git-checks --access public
```

All 15 public packages publish in dependency order. If a package version already exists on npm, pnpm skips it gracefully.

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
