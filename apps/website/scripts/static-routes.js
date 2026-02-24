/**
 * Post-build script:
 *  1. Copies index.html into each route directory for static hosting (S3, etc.)
 *  2. Generates 404.html from the SPA index for client-side routing fallback
 */
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(import.meta.dirname, '..', 'dist')
const src = join(dist, 'index.html')

const docsSections = [
  'lightpaper',
  'intro', 'install', 'config',
  'overview', 'discovery', 'transport', 'metering', 'payments', 'reputation',
  'skills', 'create-skill',
  'provider-api', 'router-api', 'create-plugin',
  'commands', 'flags',
]

const routes = [
  'lightpaper',
  'docs',
  ...docsSections.map((s) => `docs/${s}`),
]

for (const route of routes) {
  const dir = join(dist, route)
  mkdirSync(dir, { recursive: true })
  cpSync(src, join(dir, 'index.html'))
}

// 404 fallback for client-side routing
cpSync(src, join(dist, '404.html'))

console.log(`Generated ${routes.length} static route(s) + 404.html`)
