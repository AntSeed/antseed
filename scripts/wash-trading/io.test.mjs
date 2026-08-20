import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendJsonLine, collectNdjsonItems, readNdjsonPages, writeJsonAtomic, readJson } from "./io.mjs";

test("NDJSON page checkpoints remain readable and deduplicate items", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-io-"));
  try {
    const path = join(directory, "pages.ndjson");
    await appendJsonLine(path, { offset: 0, totalCount: 3, items: [{ id: "a" }, { id: "b" }] });
    await appendJsonLine(path, { offset: 2, totalCount: 3, items: [{ id: "b" }, { id: "c" }] });
    const pages = await readNdjsonPages(path);
    assert.equal(pages.size, 2);
    assert.deepEqual(await collectNdjsonItems(path, (item) => item.id), [{ id: "a" }, { id: "b" }, { id: "c" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic JSON writes replace complete documents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-json-"));
  try {
    const path = join(directory, "state.json");
    await writeJsonAtomic(path, { stage: "first" });
    await writeJsonAtomic(path, { stage: "second", complete: true });
    assert.deepEqual(await readJson(path), { stage: "second", complete: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
