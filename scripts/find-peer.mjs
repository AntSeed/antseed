#!/usr/bin/env node
// Fresh DHT lookup for a specific peerId, independent of any running buyer
// daemon's cache. Bootstraps a brand-new DHT node, performs a wildcard-topic
// lookup, fetches metadata over HTTP for every endpoint, and prints whichever
// announcement matches the requested peerId.
//
// Usage:
//   node scripts/find-peer.mjs <peerId>
//
// Requires `pnpm run build` to have produced packages/node/dist.

import {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  ANTSEED_WILDCARD_TOPIC,
  topicToInfoHash,
} from "../packages/node/dist/discovery/dht-node.js";
import { HttpMetadataResolver } from "../packages/node/dist/discovery/http-metadata-resolver.js";

const TARGET = (process.argv[2] ?? "").toLowerCase();
if (!TARGET) {
  console.error("usage: node scripts/find-peer.mjs <peerId>");
  process.exit(1);
}

// Use a non-default port to avoid colliding with a buyer/seller daemon on 6881.
const LOOKUP_PORT = 16881;
const OPERATION_TIMEOUT_MS = 25_000;
const METADATA_TIMEOUT_MS = 4_000;

/** Compose a one-line summary of a metadata document for the listing. */
function summarizeMetadata(md) {
  const peerId = (md.peerId ?? "").toLowerCase();
  const name = md.displayName ?? md.name ?? "-";

  const providerServices = Array.isArray(md.providers)
    ? md.providers.flatMap((p) =>
        Array.isArray(p?.services)
          ? p.services.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean)
          : [],
      )
    : [];
  const flatServices = Array.isArray(md.services)
    ? md.services.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean)
    : [];
  const services = providerServices.length > 0 ? providerServices : flatServices;

  return { peerId, name, services };
}

async function main() {
  console.log(`[*] target peerId: ${TARGET}`);
  console.log(`[*] starting fresh DHT node on port ${LOOKUP_PORT}...`);

  const dht = new DHTNode({
    ...DEFAULT_DHT_CONFIG,
    peerId: "00".repeat(20), // dummy — we only do lookups, never announce
    port: LOOKUP_PORT,
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
  });

  await dht.start();
  console.log(`[*] DHT ready; routing-table nodes: ${dht.getNodeCount()}`);

  const infoHash = topicToInfoHash(ANTSEED_WILDCARD_TOPIC);
  console.log(
    `[*] looking up wildcard topic '${ANTSEED_WILDCARD_TOPIC}' (${infoHash.toString("hex")})`,
  );

  const rawEndpoints = await dht.lookup(infoHash);
  console.log(`[*] DHT returned ${rawEndpoints.length} endpoint(s)`);

  const seen = new Set();
  const endpoints = [];
  for (const ep of rawEndpoints) {
    const key = `${ep.host}:${ep.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(ep);
  }
  console.log(`[*] ${endpoints.length} unique endpoint(s); resolving metadata...`);

  const resolver = new HttpMetadataResolver({ timeoutMs: METADATA_TIMEOUT_MS });

  let found = null;
  let resolved = 0;

  await Promise.allSettled(
    endpoints.map(async (peer) => {
      const md = await resolver.resolve(peer);
      if (!md) {
        console.log(`    ${peer.host}:${peer.port}  -> no metadata`);
        return;
      }
      resolved += 1;
      const { peerId, name, services } = summarizeMetadata(md);
      const isMatch = peerId === TARGET;
      const tag = isMatch ? "  <-- MATCH" : "";
      const svcSummary =
        services.length === 0
          ? "no services"
          : services.length <= 3
            ? services.join(", ")
            : `${services.slice(0, 3).join(", ")} +${services.length - 3}`;
      console.log(
        `    ${peer.host}:${peer.port}  peerId=${peerId.slice(0, 16)}…  name=${name}  [${svcSummary}]${tag}`,
      );
      if (isMatch) {
        found = { peer, md, name, services };
      }
    }),
  );

  console.log("");
  if (found) {
    const ageSec = Math.round((Date.now() - (found.md.timestamp ?? Date.now())) / 1000);
    console.log(`[✓] FOUND ${TARGET}`);
    console.log(`    endpoint:  ${found.peer.host}:${found.peer.port}`);
    console.log(`    name:      ${found.name}`);
    if (found.md.timestamp) {
      console.log(
        `    timestamp: ${new Date(found.md.timestamp).toISOString()} (age ${ageSec}s)`,
      );
    }
    console.log(`    services:  ${found.services.length} total`);
    if (found.services.length > 0) {
      const preview = found.services.slice(0, 10).join(", ");
      const more = found.services.length > 10 ? ` +${found.services.length - 10} more` : "";
      console.log(`               ${preview}${more}`);
    }
  } else {
    console.log(`[✗] peer ${TARGET} NOT FOUND on the wildcard topic`);
    console.log(
      `    (resolved metadata for ${resolved}/${endpoints.length} endpoints)`,
    );
  }

  await dht.stop();
  process.exit(found ? 0 : 1);
}

main().catch((err) => {
  console.error(`[!] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});
