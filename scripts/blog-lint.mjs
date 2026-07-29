#!/usr/bin/env node
/**
 * SEO and house-style linter for AntSeed blog posts.
 *
 * Usage:
 *   node scripts/blog-lint.mjs apps/website/blog/2026-08-04-some-post.md
 *   node scripts/blog-lint.mjs            # lints every post in the blog dir
 *
 * Exit 1 on any ERROR. WARNs are printed and do not fail the build.
 *
 * This is the guard between an AI draft and a live page. Keep it strict.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';

const BLOG_DIR = join(process.cwd(), 'apps', 'website', 'blog');

const BANNED_PHRASES = [
  'in today\'s world',
  'in the fast-paced world',
  'in conclusion',
  'as we all know',
  'game-changing',
  'game changer',
  'revolutionary',
  'cutting-edge',
  'seamlessly',
  'it is important to note',
  'delve into',
  'in the realm of',
  'unlock the power',
];

const REQUIRED_FM = ['slug', 'title', 'authors', 'tags', 'description', 'keywords', 'image', 'date'];

let errors = 0;
let warnings = 0;

const err = (file, msg) => { console.error(`ERROR  ${basename(file)}: ${msg}`); errors++; };
const warn = (file, msg) => { console.warn(`WARN   ${basename(file)}: ${msg}`); warnings++; };

function parse(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  return { fm: yaml.load(m[1]), body: m[2], raw };
}

function wordsOf(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lint(file) {
  const parsed = parse(file);
  if (!parsed) { err(file, 'no valid YAML frontmatter block'); return; }
  const { fm, body } = parsed;

  // --- frontmatter ---
  for (const key of REQUIRED_FM) {
    if (fm[key] === undefined || fm[key] === null || fm[key] === '') {
      err(file, `frontmatter missing "${key}"`);
    }
  }

  if (fm.title) {
    const len = String(fm.title).length;
    if (len > 60) err(file, `title is ${len} chars, max 60 (gets truncated in results)`);
    else if (len < 30) warn(file, `title is only ${len} chars, aim for 50 to 60`);
  }

  if (fm.description) {
    const len = String(fm.description).length;
    if (len > 155 || len < 120) {
      err(file, `description is ${len} chars, must be 120 to 155`);
    }
  }

  if (Array.isArray(fm.keywords) && fm.keywords.length < 3) {
    warn(file, `only ${fm.keywords.length} keywords, aim for 5 to 7`);
  }
  if (Array.isArray(fm.tags) && (fm.tags.length < 3 || fm.tags.length > 8)) {
    warn(file, `${fm.tags.length} tags, aim for 4 to 7`);
  }

  // filename must agree with slug and date
  const fname = basename(file);
  if (fm.slug && !fname.includes(fm.slug)) {
    err(file, `filename does not contain the slug "${fm.slug}"`);
  }
  if (fm.date) {
    // js-yaml turns an unquoted YYYY-MM-DD into a Date object, so normalise both cases
    const d = fm.date instanceof Date
      ? fm.date.toISOString().slice(0, 10)
      : String(fm.date).slice(0, 10);
    if (!fname.startsWith(d)) err(file, `filename date does not match frontmatter date ${d}`);
  }

  // --- body structure ---
  if (!body.includes('<!-- truncate -->')) {
    err(file, 'missing <!-- truncate --> marker');
  } else {
    const intro = body.split('<!-- truncate -->')[0];
    const introWords = wordsOf(intro).length;
    if (introWords < 40) warn(file, `intro before truncate is only ${introWords} words`);
    if (introWords > 220) warn(file, `intro before truncate is ${introWords} words, that is a lot for an excerpt`);

    // primary keyword should show up early
    const first100 = wordsOf(intro).slice(0, 100).join(' ').toLowerCase();
    const kw = Array.isArray(fm.keywords) ? String(fm.keywords[0] || '').toLowerCase() : '';
    if (kw) {
      const kwWords = kw.split(/\s+/).filter((w) => w.length > 3);
      const hit = kwWords.length > 0 && kwWords.every((w) => first100.includes(w));
      if (!hit) warn(file, `primary keyword "${kw}" not clearly in the first 100 words`);
    }
  }

  if (/^# /m.test(body)) {
    err(file, 'body contains an H1, Docusaurus renders the frontmatter title as H1');
  }

  const h2s = body.match(/^## /gm) || [];
  if (h2s.length < 3) warn(file, `only ${h2s.length} H2 sections, thin structure`);

  // heading level skips
  const levels = [...body.matchAll(/^(#{2,6}) /gm)].map((m) => m[1].length);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      warn(file, 'heading levels skip a level somewhere, H2 then H4');
      break;
    }
  }

  // --- links ---
  const links = [...body.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  const internal = links.filter((l) => l[2].startsWith('/') || l[2].includes('antseed.com'));
  const external = links.filter((l) => l[2].startsWith('http') && !l[2].includes('antseed.com'));

  if (internal.length < 2) err(file, `only ${internal.length} internal links, minimum 2`);
  if (external.length < 1) warn(file, 'no outbound links to a primary source');

  for (const l of links) {
    if (/^(click here|read more|here|this|link|this article)$/i.test(l[1].trim())) {
      err(file, `non-descriptive anchor text: "${l[1]}"`);
    }
  }

  // --- house style ---
  if (body.includes('\u2014')) {
    err(file, 'em dash found, house style uses -- or a restructured sentence');
  }

  const lower = body.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) err(file, `banned phrase: "${phrase}"`);
  }

  // crypto framing guard
  const cryptoHits = ['tokenomics', 'to the moon', 'hodl', 'airdrop', 'price action', 'market cap']
    .filter((t) => lower.includes(t));
  if (cryptoHits.length) {
    warn(file, `crypto framing detected (${cryptoHits.join(', ')}), confirm this is intentional`);
  }

  // --- length ---
  const count = wordsOf(body).length;
  if (count < 800) err(file, `${count} words, minimum 800`);
  else if (count < 1200) warn(file, `${count} words, most cluster posts should clear 1200`);

  if (errors === 0) console.log(`ok     ${basename(file)}  (${count} words, ${h2s.length} H2, ${internal.length} internal links)`);
}

// --- duplicate slug / keyword check across the whole blog ---
function crossCheck(files) {
  const slugs = new Map();
  const kws = new Map();
  for (const f of files) {
    const p = parse(f);
    if (!p) continue;
    const { fm } = p;
    if (fm.slug) {
      if (slugs.has(fm.slug)) err(f, `duplicate slug, also used by ${basename(slugs.get(fm.slug))}`);
      slugs.set(fm.slug, f);
    }
    const kw = Array.isArray(fm.keywords) ? String(fm.keywords[0] || '').toLowerCase().trim() : '';
    if (kw) {
      if (kws.has(kw)) {
        warn(f, `primary keyword "${kw}" also targeted by ${basename(kws.get(kw))}, possible cannibalization`);
      }
      kws.set(kw, f);
    }
  }
}

const args = process.argv.slice(2);
let files;

if (args.length) {
  files = args;
} else {
  if (!existsSync(BLOG_DIR)) { console.error(`no blog dir at ${BLOG_DIR}`); process.exit(1); }
  files = readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith('.md') || f.endsWith('.mdx'))
    .map((f) => join(BLOG_DIR, f));
}

for (const f of files) lint(f);

// cross-check always runs against the full directory
if (existsSync(BLOG_DIR)) {
  crossCheck(
    readdirSync(BLOG_DIR)
      .filter((f) => f.endsWith('.md') || f.endsWith('.mdx'))
      .map((f) => join(BLOG_DIR, f))
  );
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors > 0 ? 1 : 0);
