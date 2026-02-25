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

Use pnpm to bump all workspace package versions in a single command. **Never edit each package.json manually.**

```bash
# Bump all 12 publishable packages at once
pnpm -r --filter './packages/*' --filter './plugins/*' --filter '@antseed/dashboard' --filter '@antseed/cli' exec npm version <patch|minor|major> --no-git-tag-version
```

This bumps: `@antseed/node`, `@antseed/provider-core`, `@antseed/router-core`, all plugins, `@antseed/dashboard`, and `@antseed/cli`. Private packages (e2e, desktop, website) are excluded by the filter.

Verify the bump worked:

```bash
pnpm -r --filter './packages/*' --filter './plugins/*' --filter '@antseed/dashboard' --filter '@antseed/cli' exec -- node -p 'require("./package.json").name + "@" + require("./package.json").version'
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

All 12 public packages publish in dependency order. If a package version already exists on npm, pnpm skips it gracefully.

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
- The `e2e`, `@antseed/desktop`, and `@antseed/website` packages are private and are automatically skipped.
- All publishable packages have `"files": ["dist"]` to keep tarballs clean.
- The `@antseed/dashboard` package includes `"files": ["dist", "dist-web"]` for the bundled web frontend.
- The `@antseed/node` package includes `"files": ["dist", "scripts"]` for the postinstall patch script.

## Package dependency order (for reference)

```
tier0: @antseed/node
tier1: @antseed/provider-core, @antseed/router-core
tier2: provider-anthropic, provider-claude-code, provider-claude-oauth,
       provider-openrouter, provider-local-llm, router-local-chat, router-local-proxy
tier3: @antseed/dashboard
tier4: @antseed/cli
```
