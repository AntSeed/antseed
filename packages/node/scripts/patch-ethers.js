/**
 * Patches ethers v6 lib.esm/index.d.ts to avoid type-checking raw TypeScript sources.
 *
 * ethers v6 ships a lib.esm/index.d.ts that re-exports directly from the package's
 * own TypeScript source tree (src.ts/). Because these are .ts files (not .d.ts),
 * TypeScript's skipLibCheck does not apply to them and they fail under strict settings.
 *
 * The fix: redirect the two offending lines to the CJS build's ethers.d.ts, which
 * contains only compiled, relative-path imports and is clean under any tsconfig.
 *
 * Related: https://github.com/ethers-io/ethers.js/issues/4014
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const indexDts = resolve(__dirname, '../node_modules/ethers/lib.esm/index.d.ts')

if (!existsSync(indexDts)) {
  // ethers not installed (optional dep scenario) — skip silently
  process.exit(0)
}

const original = readFileSync(indexDts, 'utf-8')

if (!original.includes('../src.ts/ethers.ts')) {
  // Already patched or a fixed version of ethers — nothing to do
  process.exit(0)
}

const patched = original
  .replace(
    'import * as ethers from "../src.ts/ethers.ts";',
    'import * as ethers from "../lib.commonjs/ethers.js";'
  )
  .replace(
    'export * from "../src.ts/ethers.ts";',
    'export * from "../lib.commonjs/ethers.js";'
  )

writeFileSync(indexDts, patched, 'utf-8')
console.log('patched ethers/lib.esm/index.d.ts → uses compiled CJS declarations')
