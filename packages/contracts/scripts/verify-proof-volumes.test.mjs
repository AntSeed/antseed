import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { AbiCoder } from "ethers";
import { authenticateBaselineReceipts, compareVolumeBaseline, createVolumeBaseline, signVolumeBaseline, verifyVolumeBaselineSignature } from "./verify-proof-volumes.mjs";

const CHANNEL_SETTLED_TOPIC = "0x0b287f37d8bd14ef37f2966734ab387c243cc1a1663616a25a4cc259877736b1";

test("volume baseline binds exact settlement identities and raw volume", () => {
  const baseline = createVolumeBaseline(plan(), bundle());
  assert.equal(baseline.claims[0].volumeRaw, "1000000000");
  assert.equal(baseline.claims[0].settlements.length, 3);
  assert.equal(baseline.claims[0].settlements[0].amountRaw, "400000000");
});

test("volume baseline signature rejects any evidence mutation", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signVolumeBaseline(createVolumeBaseline(plan(), bundle()), privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.equal(verifyVolumeBaselineSignature(signed, publicKey.export({ type: "spki", format: "pem" })), true);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => verifyVolumeBaselineSignature(signed, other), /signer is not trusted/);
  signed.body.claims[0].settlements[0].amountRaw = "399999999";
  assert.throws(() => verifyVolumeBaselineSignature(signed), /digest mismatch/);
});

test("receipt authentication sums repeated settlements from the delta word", async () => {
  const proofPlan = plan();
  const sharedHash = `0x${"a".repeat(64)}`;
  for (const [index, settlement] of proofPlan.claims[0].selectedEvidence.entries()) {
    settlement.transactionHash = sharedHash;
    settlement.blockNumber = 46_303_100;
    settlement.transactionIndex = 7;
    settlement.logIndex = index;
  }
  const baseline = createVolumeBaseline(proofPlan, bundle());
  const logs = baseline.claims[0].settlements.map((settlement, index) => settledLog(settlement, 10_000_000_000n + BigInt(index)));
  let reads = 0;
  const receiptVolumes = await authenticateBaselineReceipts(baseline, bundle(), async () => {
    reads += 1;
    return {
      status: "0x1",
      transactionHash: sharedHash,
      blockNumber: `0x${(46_303_100).toString(16)}`,
      transactionIndex: "0x7",
      logs,
    };
  });
  assert.equal(reads, 1);
  assert.equal(receiptVolumes[0].volumeRaw, "1000000000");
});

test("duplicate settlement identities and uint128 overflow are rejected", () => {
  const duplicate = plan();
  duplicate.claims[0].selectedEvidence.push({ ...duplicate.claims[0].selectedEvidence[0], dependencyId: "duplicate" });
  assert.throws(() => createVolumeBaseline(duplicate, bundle()), /duplicate settlement/);

  const overflow = plan();
  overflow.claims[0].selectedEvidence = [{ ...overflow.claims[0].selectedEvidence[0], amountRaw: (1n << 128n).toString() }];
  overflow.claims[0].provenVolumeRaw = (1n << 128n).toString();
  assert.throws(() => createVolumeBaseline(overflow, bundle()), /outside uint128/);
});

test("reciprocal volumes use the guest-normalized pair directions", () => {
  const addressA = "0x0000000000000000000000000000000000000001";
  const addressB = "0x0000000000000000000000000000000000000002";
  const reciprocal = {
    version: 1,
    kind: "antseed-wash-trading-proof-plan",
    chainId: 8_453,
    reportRoot: "0x01",
    claims: [{
      claimId: "0xpair",
      type: "P0_RECIPROCAL",
      subjects: [addressB, addressA],
      selectedEvidence: [
        reciprocalSettlement(1, addressA, addressB, 11n),
        reciprocalSettlement(2, addressB, addressA, 13n),
      ],
    }],
  };
  const baseline = createVolumeBaseline(reciprocal, bundle());
  assert.deepEqual(baseline.claims[0].subjects, [addressA, addressB]);
  assert.equal(baseline.claims[0].volumeAToBRaw, "11");
  assert.equal(baseline.claims[0].volumeBToARaw, "13");
});

test("volume comparison uses host metrics while the proof journal stays minimal", () => {
  const proofPlan = plan();
  const { privateKey } = generateKeyPairSync("ed25519");
  const baseline = signVolumeBaseline(
    createVolumeBaseline(proofPlan, bundle()),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const seller = proofPlan.claims[0].subjects[0];
  const results = {
    version: 1,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    entries: [{
      claimId: proofPlan.claims[0].claimId,
      claimType: "P0_CLOSED_LOOP",
      subjects: [seller],
      metrics: { qualifiedVolumeRaw: "1000000000" },
      journalBytes: AbiCoder.defaultAbiCoder().encode(
        ["tuple(address seller,tuple(uint64 number,bytes32 blockHash)[] blockRefs)"],
        [[seller, [[46_303_100, `0x${"4".repeat(64)}`]]]],
      ),
    }],
  };

  const report = compareVolumeBaseline(baseline, proofPlan, results);
  assert.equal(report.version, 2);
  assert.equal(report.ok, true);
  assert.equal(report.claims[0].hostVolumeRaw, "1000000000");

  results.entries[0].metrics.qualifiedVolumeRaw = "999999999";
  assert.equal(compareVolumeBaseline(baseline, proofPlan, results).ok, false);
});

function plan() {
  const settlements = [400_000_000n, 300_000_000n, 300_000_000n].map((amount, index) => ({
    dependencyId: `settlement-${index}`,
    evidenceType: "SETTLEMENT",
    transactionHash: `0x${String(index + 1).repeat(64)}`,
    blockNumber: 46_303_100 + index,
    transactionIndex: index,
    logIndex: index,
    buyer: `0x${String(index + 1).padStart(40, "0")}`,
    seller: "0x0000000000000000000000000000000000000010",
    amountRaw: amount.toString(),
  }));
  return {
    version: 1,
    kind: "antseed-wash-trading-proof-plan",
    chainId: 8_453,
    reportRoot: "0x01",
    claims: [{
      claimId: "0xclaim",
      type: "P0_CLOSED_LOOP",
      subjects: ["0x0000000000000000000000000000000000000010"],
      funder: "0x0000000000000000000000000000000000000020",
      cohortHash: `0x${"3".repeat(64)}`,
      provenVolumeRaw: "1000000000",
      selectedEvidence: settlements,
    }],
  };
}

function bundle() {
  return { chainId: 8_453, reportRoot: "0x01", contracts: { channels: "0x0000000000000000000000000000000000000040" } };
}

function reciprocalSettlement(index, buyer, seller, amountRaw) {
  return {
    dependencyId: `reciprocal-${index}`,
    evidenceType: "RECIPROCAL_SETTLEMENT",
    transactionHash: `0x${String(index).repeat(64)}`,
    blockNumber: 46_303_100 + index,
    transactionIndex: index,
    logIndex: index,
    buyer,
    seller,
    amountRaw: amountRaw.toString(),
  };
}

function settledLog(settlement, cumulative) {
  return {
    address: bundle().contracts.channels,
    transactionHash: settlement.transactionHash,
    blockNumber: `0x${settlement.blockNumber.toString(16)}`,
    logIndex: `0x${settlement.logIndex.toString(16)}`,
    topics: [CHANNEL_SETTLED_TOPIC, `0x${"0".repeat(64)}`, addressTopic(settlement.buyer), addressTopic(settlement.seller)],
    data: `0x${word(cumulative)}${word(BigInt(settlement.amountRaw))}${word(cumulative)}${word(0n)}${word(0n)}`,
  };
}

function addressTopic(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function word(value) {
  return value.toString(16).padStart(64, "0");
}
