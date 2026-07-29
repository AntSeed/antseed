#!/usr/bin/env node
/**
 * Picks the next post to write from content/blog-queue.yml.
 *
 * Order: FORCE_SLUG if set, otherwise the first entry with status: queued.
 * Emits GitHub Actions outputs. Exits 0 with an empty slug if nothing is queued,
 * so an empty queue is a no-op rather than a red build.
 *
 * Usage: node scripts/blog-next.mjs
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const QUEUE_PATH = join(process.cwd(), 'content', 'blog-queue.yml');
const BLOG_DIR = join(process.cwd(), 'apps', 'website', 'blog');

function out(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  const str = String(value ?? '');
  if (file) {
    // multiline-safe heredoc form
    const delim = `EOF_${key}_${Math.random().toString(36).slice(2)}`;
    appendFileSync(file, `${key}<<${delim}\n${str}\n${delim}\n`);
  }
  console.log(`${key} = ${str.split('\n')[0].slice(0, 120)}`);
}

if (!existsSync(QUEUE_PATH)) {
  console.error(`queue not found at ${QUEUE_PATH}`);
  process.exit(1);
}

const queue = yaml.load(readFileSync(QUEUE_PATH, 'utf8'));
const posts = queue?.posts ?? [];

if (!Array.isArray(posts) || posts.length === 0) {
  console.log('queue is empty');
  out('slug', '');
  process.exit(0);
}

const force = (process.env.FORCE_SLUG || '').trim();
let entry;

if (force) {
  entry = posts.find((p) => p.slug === force);
  if (!entry) {
    console.error(`slug "${force}" is not in the queue`);
    process.exit(1);
  }
} else {
  entry = posts.find((p) => p.status === 'queued');
}

if (!entry) {
  console.log('nothing with status: queued left in the queue');
  out('slug', '');
  process.exit(0);
}

// Guard: refuse to write over an existing post with the same slug.
if (existsSync(BLOG_DIR)) {
  const { readdirSync } = await import('node:fs');
  const clash = readdirSync(BLOG_DIR).some((f) => f.includes(entry.slug));
  if (clash && !force) {
    console.error(`a post for "${entry.slug}" already exists in ${BLOG_DIR}`);
    console.error('set its queue status to published, or use workflow_dispatch with a forced slug');
    process.exit(1);
  }
}

const today = new Date().toISOString().slice(0, 10);

out('slug', entry.slug);
out('filename', `${today}-${entry.slug}.md`);
out('date', today);
out('primary_keyword', entry.primary_keyword ?? '');
out('title_draft', entry.title_draft ?? '');
out('entry_yaml', yaml.dump(entry, { lineWidth: 100 }));
