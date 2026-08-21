#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { decodeAndValidateEntry } from "./submit-wash-trading-proofs.mjs";

const CHANNEL_SETTLED_TOPIC = "0x0b287f37d8bd14ef37f2966734ab387c243cc1a1663616a25a4cc259877736b1";
const MAX_U128 = (1n << 128n) - 1n;

export function createVolumeBaseline(plan, bundle) {
  validateInputs(plan, bundle);
  const claims = plan.claims.map((claim) => summarizeClaim(claim));
  return {
    version: 1,
    kind: "antseed-proof-volume-baseline",
    chainId: plan.chainId,
    reportRoot: plan.reportRoot,
    claimCount: claims.length,
    claims,
  };
}

export function signVolumeBaseline(body, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const digest = baselineDigest(body);
  return {
    body,
    attestation: {
      algorithm: "ed25519",
      digest,
      publicKey,
      signature: sign(null, Buffer.from(digest.slice(2), "hex"), privateKey).toString("base64"),
    },
  };
}

export function verifyVolumeBaselineSignature(baseline, expectedPublicKeyPem = null) {
  if (baseline?.attestation?.algorithm !== "ed25519") throw new Error("volume baseline is not Ed25519-signed");
  const digest = baselineDigest(baseline.body);
  if (digest !== baseline.attestation.digest) throw new Error("volume baseline digest mismatch");
  if (expectedPublicKeyPem != null) {
    const actual = createPublicKey(baseline.attestation.publicKey).export({ type: "spki", format: "der" });
    const expected = createPublicKey(expectedPublicKeyPem).export({ type: "spki", format: "der" });
    if (!actual.equals(expected)) throw new Error("volume baseline signer is not trusted");
  }
  const valid = verify(
    null,
    Buffer.from(digest.slice(2), "hex"),
    baseline.attestation.publicKey,
    Buffer.from(baseline.attestation.signature, "base64"),
  );
  if (!valid) throw new Error("volume baseline signature is invalid");
  return true;
}

export async function authenticateBaselineReceipts(body, bundle, callRpc) {
  const channels = bundle.contracts.channels.toLowerCase();
  const receiptCache = new Map();
  const receiptVolumes = [];
  for (const claim of body.claims) {
    const authenticated = [];
    for (const settlement of claim.settlements) {
      let receipt = receiptCache.get(settlement.transactionHash);
      if (!receipt) {
        receipt = await callRpc("eth_getTransactionReceipt", [settlement.transactionHash]);
        receiptCache.set(settlement.transactionHash, receipt);
      }
      if (!receipt || receipt.status == null || BigInt(receipt.status) !== 1n) throw new Error(`${claim.claimId}: settlement receipt is missing or reverted`);
      if (requiredLower(receipt.transactionHash, `${claim.claimId} receipt transaction hash`) !== settlement.transactionHash
          || rpcNumber(receipt.blockNumber, `${claim.claimId} receipt block number`) !== settlement.blockNumber
          || rpcNumber(receipt.transactionIndex, `${claim.claimId} receipt transaction index`) !== settlement.transactionIndex) {
        throw new Error(`${claim.claimId}: authenticated receipt identity differs from baseline`);
      }
      const matches = (receipt.logs ?? []).filter((log) => rpcNumber(log.logIndex, `${claim.claimId} log index`) === settlement.logIndex);
      if (matches.length !== 1) throw new Error(`${claim.claimId}: expected exact settlement log ${settlement.logIndex}`);
      const log = matches[0];
      const topics = (log.topics ?? []).map((topic) => topic.toLowerCase());
      if (log.address.toLowerCase() !== channels || topics[0] !== CHANNEL_SETTLED_TOPIC
          || topicAddress(topics[2]) !== settlement.buyer || topicAddress(topics[3]) !== settlement.seller
          || dataWord(log.data, 1) !== BigInt(settlement.amountRaw)) {
        throw new Error(`${claim.claimId}: authenticated settlement differs from baseline`);
      }
      if (log.transactionHash != null && requiredLower(log.transactionHash, `${claim.claimId} log transaction hash`) !== settlement.transactionHash) {
        throw new Error(`${claim.claimId}: authenticated log transaction differs from baseline`);
      }
      if (log.blockNumber != null && rpcNumber(log.blockNumber, `${claim.claimId} log block number`) !== settlement.blockNumber) {
        throw new Error(`${claim.claimId}: authenticated log block differs from baseline`);
      }
      authenticated.push(settlement);
    }
    receiptVolumes.push(summarizeAuthenticatedClaim(claim, authenticated));
  }
  return receiptVolumes;
}

export function compareVolumeBaseline(baseline, plan, results, receiptVolumes = null) {
  verifyVolumeBaselineSignature(baseline);
  const current = createVolumeBaseline(plan, { chainId: plan.chainId, reportRoot: plan.reportRoot, contracts: { channels: "0x0000000000000000000000000000000000000001" } });
  const differences = [];
  compareField(differences, "claimCount", baseline.body.claimCount, current.claimCount);
  const currentById = new Map(current.claims.map((claim) => [claim.claimId.toLowerCase(), claim]));
  const baselineIds = new Set(baseline.body.claims.map((claim) => claim.claimId.toLowerCase()));
  for (const claim of baseline.body.claims) {
    const next = currentById.get(claim.claimId.toLowerCase());
    if (!next) {
      differences.push({ claimId: claim.claimId, field: "claim", expected: "present", actual: "missing" });
      continue;
    }
    compareField(differences, "subjects", JSON.stringify(claim.subjects), JSON.stringify(next.subjects), claim.claimId);
    for (const field of ["claimType", "funder", "cohortHash", "volumeRaw", "volumeAToBRaw", "volumeBToARaw"]) {
      compareField(differences, field, claim[field] ?? null, next[field] ?? null, claim.claimId);
    }
    compareField(differences, "settlements", JSON.stringify(claim.settlements), JSON.stringify(next.settlements), claim.claimId);
  }
  for (const claim of current.claims) if (!baselineIds.has(claim.claimId.toLowerCase())) differences.push({ claimId: claim.claimId, field: "claim", expected: "absent", actual: "added" });

  if (!Array.isArray(results?.entries)) throw new Error("proof results are missing entries");
  const resultsById = uniqueByClaimId(results.entries, "proof result");
  const receiptsById = receiptVolumes == null ? null : uniqueByClaimId(receiptVolumes, "receipt volume");
  const claims = [];
  for (const claim of baseline.body.claims) {
    const result = resultsById.get(claim.claimId.toLowerCase());
    if (!result) {
      differences.push({ claimId: claim.claimId, field: "result", expected: "present", actual: "missing" });
      continue;
    }
    const journal = decodeAndValidateEntry(result, results.chainId);
    compareField(
      differences,
      "proof.subjects",
      JSON.stringify(claim.subjects),
      JSON.stringify(journal.subjects.map((subject) => subject.toLowerCase())),
      claim.claimId,
    );
    const receipt = receiptsById?.get(claim.claimId.toLowerCase()) ?? null;
    if (claim.claimType === "P0_CLOSED_LOOP") {
      const hostVolumeRaw = boundedRaw(result.metrics?.qualifiedVolumeRaw, `${claim.claimId} host qualified volume`).toString();
      compareField(differences, "host.volumeRaw", claim.volumeRaw, hostVolumeRaw, claim.claimId);
      if (receiptsById) compareField(differences, "receipt.volumeRaw", claim.volumeRaw, receipt?.volumeRaw ?? null, claim.claimId);
      claims.push({ claimId: claim.claimId, claimType: claim.claimType, baselineVolumeRaw: claim.volumeRaw, plannerVolumeRaw: currentById.get(claim.claimId.toLowerCase())?.volumeRaw ?? null, receiptVolumeRaw: receipt?.volumeRaw ?? null, hostVolumeRaw });
    } else {
      const hostVolumeAToBRaw = boundedRaw(result.metrics?.volumeAToBRaw, `${claim.claimId} host A-to-B volume`).toString();
      const hostVolumeBToARaw = boundedRaw(result.metrics?.volumeBToARaw, `${claim.claimId} host B-to-A volume`).toString();
      compareField(differences, "host.volumeAToBRaw", claim.volumeAToBRaw, hostVolumeAToBRaw, claim.claimId);
      compareField(differences, "host.volumeBToARaw", claim.volumeBToARaw, hostVolumeBToARaw, claim.claimId);
      if (receiptsById) {
        compareField(differences, "receipt.volumeAToBRaw", claim.volumeAToBRaw, receipt?.volumeAToBRaw ?? null, claim.claimId);
        compareField(differences, "receipt.volumeBToARaw", claim.volumeBToARaw, receipt?.volumeBToARaw ?? null, claim.claimId);
      }
      const planned = currentById.get(claim.claimId.toLowerCase());
      claims.push({ claimId: claim.claimId, claimType: claim.claimType, baselineVolumeAToBRaw: claim.volumeAToBRaw, baselineVolumeBToARaw: claim.volumeBToARaw, plannerVolumeAToBRaw: planned?.volumeAToBRaw ?? null, plannerVolumeBToARaw: planned?.volumeBToARaw ?? null, receiptVolumeAToBRaw: receipt?.volumeAToBRaw ?? null, receiptVolumeBToARaw: receipt?.volumeBToARaw ?? null, hostVolumeAToBRaw, hostVolumeBToARaw });
    }
  }
  return { version: 2, kind: "antseed-proof-volume-report", baselineDigest: baselineDigest(baseline.body), claimCount: baseline.body.claimCount, ok: differences.length === 0, claims, differences };
}

function summarizeClaim(claim) {
  const settlements = claim.selectedEvidence
    .filter((entry) => entry.evidenceType === "SETTLEMENT" || entry.evidenceType === "RECIPROCAL_SETTLEMENT")
    .map((entry) => ({
      transactionHash: requiredLower(entry.transactionHash, `${claim.claimId} settlement transaction hash`),
      blockNumber: entry.blockNumber,
      transactionIndex: entry.transactionIndex,
      logIndex: entry.logIndex,
      buyer: requiredLower(entry.buyer, `${claim.claimId} settlement buyer`),
      seller: requiredLower(entry.seller ?? claim.subjects[0], `${claim.claimId} settlement seller`),
      amountRaw: boundedRaw(entry.amountRaw, `${claim.claimId} settlement amount`).toString(),
    }))
    .sort(compareSettlement);
  if (settlements.length === 0) throw new Error(`${claim.claimId}: claim has no selected settlements`);
  const identities = new Set();
  for (const settlement of settlements) {
    const identity = `${settlement.transactionHash}:${settlement.logIndex}`;
    if (identities.has(identity)) throw new Error(`${claim.claimId}: duplicate settlement ${identity}`);
    identities.add(identity);
  }
  const subjects = claim.subjects.map((subject) => subject.toLowerCase());
  if (claim.type === "P0_RECIPROCAL") subjects.sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
  const summary = {
    claimId: claim.claimId,
    claimType: claim.type,
    subjects,
    funder: claim.funder?.toLowerCase() ?? null,
    cohortHash: claim.cohortHash?.toLowerCase() ?? null,
    settlements,
  };
  if (claim.type === "P0_CLOSED_LOOP") {
    const volume = sum(settlements);
    if (claim.provenVolumeRaw != null && BigInt(claim.provenVolumeRaw) !== volume) throw new Error(`${claim.claimId}: planner volume differs from selected settlements`);
    summary.volumeRaw = volume.toString();
  } else if (claim.type === "P0_RECIPROCAL") {
    if (summary.subjects.length !== 2 || summary.subjects[0] === summary.subjects[1]) throw new Error(`${claim.claimId}: reciprocal pair is invalid`);
    const [addressA, addressB] = summary.subjects;
    const unmatched = settlements.filter((entry) => !((entry.buyer === addressA && entry.seller === addressB) || (entry.buyer === addressB && entry.seller === addressA)));
    if (unmatched.length) throw new Error(`${claim.claimId}: reciprocal settlement is outside the normalized pair`);
    summary.volumeAToBRaw = boundedSum(settlements.filter((entry) => entry.buyer === addressA && entry.seller === addressB), `${claim.claimId} A-to-B volume`).toString();
    summary.volumeBToARaw = boundedSum(settlements.filter((entry) => entry.buyer === addressB && entry.seller === addressA), `${claim.claimId} B-to-A volume`).toString();
  } else {
    throw new Error(`${claim.claimId}: unsupported claim type ${claim.type}`);
  }
  return summary;
}

function validateInputs(plan, bundle) {
  if (plan?.version !== 1 || plan?.kind !== "antseed-wash-trading-proof-plan" || !Array.isArray(plan.claims)) throw new Error("unsupported proof plan");
  if (plan.chainId !== 8_453 || bundle.chainId !== plan.chainId || bundle.reportRoot !== plan.reportRoot) throw new Error("proof plan and bundle identity mismatch");
}

function baselineDigest(body) {
  return `0x${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

function compareField(differences, field, expected, actual, claimId = null) {
  if (expected !== actual) differences.push({ claimId, field, expected, actual });
}

function compareSettlement(left, right) {
  return left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex || left.transactionHash.localeCompare(right.transactionHash);
}

function sum(settlements) {
  return boundedSum(settlements, "settlement volume");
}

function boundedSum(settlements, label) {
  const total = settlements.reduce((value, entry) => value + boundedRaw(entry.amountRaw, label), 0n);
  if (total > MAX_U128) throw new Error(`${label} exceeds uint128`);
  return total;
}

function boundedRaw(value, label) {
  const amount = BigInt(value);
  if (amount <= 0n || amount > MAX_U128) throw new Error(`${label} is outside uint128`);
  return amount;
}

function summarizeAuthenticatedClaim(claim, settlements) {
  if (claim.claimType === "P0_CLOSED_LOOP") return { claimId: claim.claimId, volumeRaw: boundedSum(settlements, `${claim.claimId} receipt volume`).toString() };
  const [addressA, addressB] = claim.subjects;
  return {
    claimId: claim.claimId,
    volumeAToBRaw: boundedSum(settlements.filter((entry) => entry.buyer === addressA && entry.seller === addressB), `${claim.claimId} receipt A-to-B volume`).toString(),
    volumeBToARaw: boundedSum(settlements.filter((entry) => entry.buyer === addressB && entry.seller === addressA), `${claim.claimId} receipt B-to-A volume`).toString(),
  };
}

function uniqueByClaimId(entries, label) {
  const values = new Map();
  for (const entry of entries) {
    const claimId = requiredLower(entry.claimId, `${label} claim ID`);
    if (values.has(claimId)) throw new Error(`duplicate ${label} claim ID ${entry.claimId}`);
    values.set(claimId, entry);
  }
  return values;
}

function rpcNumber(value, label) {
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is not a safe integer`);
  return number;
}

function requiredLower(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value.toLowerCase();
}

function topicAddress(topic) {
  return topic ? `0x${topic.slice(-40)}`.toLowerCase() : null;
}

function dataWord(data, index) {
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function rpc(url, method, params) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const bundle = JSON.parse(await readFile(value("--bundle"), "utf8"));
  const plan = JSON.parse(await readFile(value("--plan"), "utf8"));
  const rpcUrl = value("--rpc-url") ?? process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("--rpc-url or BASE_RPC_URL is required");
  if (command === "capture") {
    const body = createVolumeBaseline(plan, bundle);
    if (body.claimCount !== 26) throw new Error("deployment baseline must contain exactly 26 claims");
    await authenticateBaselineReceipts(body, bundle, (method, params) => rpc(rpcUrl, method, params));
    const keyPath = value("--signing-key");
    if (!keyPath || !value("--out")) throw new Error("capture requires --signing-key and --out");
    const signed = signVolumeBaseline(body, await readFile(keyPath, "utf8"));
    await writeFile(value("--out"), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  if (command === "verify") {
    const baseline = JSON.parse(await readFile(value("--baseline"), "utf8"));
    const results = JSON.parse(await readFile(value("--results"), "utf8"));
    const trustedKeyPath = value("--trusted-public-key") ?? process.env.VOLUME_BASELINE_PUBLIC_KEY;
    if (!trustedKeyPath) throw new Error("verify requires --trusted-public-key or VOLUME_BASELINE_PUBLIC_KEY");
    verifyVolumeBaselineSignature(baseline, await readFile(trustedKeyPath, "utf8"));
    if (baseline.body.claimCount !== 26) throw new Error("deployment baseline must contain exactly 26 claims");
    const receiptVolumes = await authenticateBaselineReceipts(baseline.body, bundle, (method, params) => rpc(rpcUrl, method, params));
    const report = compareVolumeBaseline(baseline, plan, results, receiptVolumes);
    if (value("--report")) await writeFile(value("--report"), `${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) throw new Error(`volume equivalence failed with ${report.differences.length} differences`);
    return;
  }
  throw new Error("usage: verify-proof-volumes.mjs (capture|verify) --bundle ... --plan ... --rpc-url ...");
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
