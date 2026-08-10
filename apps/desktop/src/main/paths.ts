/**
 * Filesystem anchors for the compiled main process.
 *
 * This module deliberately lives at the root of `src/main`: its own
 * `import.meta.url` always resolves to `dist/main`, so every caller gets the
 * same answer no matter which feature folder it sits in. Modules under
 * `chat/`, `runtime/`, `ui/`, … must use these constants instead of walking
 * `../..` from their own `__dirname`, which silently breaks whenever a file
 * changes depth.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<app>/dist/main` — the compiled main process, and where `preload.cjs` lands. */
export const MAIN_DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `<app>` — the desktop app root: contains `dist/`, `assets/`, `scripts/`. */
export const DESKTOP_ROOT_DIR = path.resolve(MAIN_DIST_DIR, '..', '..');

/** Sandboxed preload bundle, emitted next to `main.js`. */
export const PRELOAD_PATH = path.join(MAIN_DIST_DIR, 'preload.cjs');

/** Production renderer entry (dev uses `VITE_DEV_SERVER_URL` instead). */
export const RENDERER_INDEX_PATH = path.join(MAIN_DIST_DIR, '..', 'renderer', 'index.html');

/** `<app>/assets` — tray/dock icons and other packaged art. */
export const ASSETS_DIR = path.join(DESKTOP_ROOT_DIR, 'assets');

/**
 * The monorepo `apps/` directory in a dev checkout. Used to locate the local
 * CLI build and workspace plugin sources; absent in a packaged install, so
 * every caller treats a miss as "fall back to the bundled copy".
 */
export const WORKSPACE_APPS_DIR = path.resolve(DESKTOP_ROOT_DIR, '..');
