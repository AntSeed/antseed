import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path, text) {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

export async function appendJsonLine(path, value) {
  await ensureDirectory(dirname(path));
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readNdjsonPages(path) {
  const pages = new Map();
  try {
    for await (const page of iterateNdjson(path)) {
      if (Number.isInteger(page?.offset) && Array.isArray(page.items)) pages.set(page.offset, page);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return pages;
    throw error;
  }
  return pages;
}

export async function* iterateNdjson(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed);
  }
}

export async function collectNdjsonItems(path, dedupeKey) {
  const items = [];
  const seen = new Set();
  for await (const page of iterateNdjson(path)) {
    for (const item of page.items ?? []) {
      const key = dedupeKey(item);
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function cachePath(cacheDirectory, namespace, key) {
  const digest = sha256(key);
  return join(cacheDirectory, namespace, digest.slice(0, 2), `${digest}.json`);
}

export function stringifyError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
