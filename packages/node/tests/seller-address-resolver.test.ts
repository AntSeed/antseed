import { describe, it, expect, beforeEach, vi } from "vitest";
import { Wallet } from "ethers";
import { SellerAddressResolver, SellerDelegationVerificationError } from "../src/discovery/seller-address-resolver.js";
import type { PeerMetadata } from "../src/discovery/peer-metadata.js";
import type { PeerId } from "../src/types/peer.js";
import { toPeerId } from "../src/types/peer.js";

const CHAIN_ID = 8453;
const PROXY = "0x" + "ab".repeat(20);

/** Build a signed SellerDelegation payload. Returns the PeerMetadata with sellerDelegation populated. */
async function buildSignedDelegation(
  operator: Wallet,
  peerAddress: string,
  expiresAt: number,
  sellerContract: string = PROXY,
  chainId: number = CHAIN_ID,
): Promise<{ signature: string }> {
  const domain = {
    name: "DiemStakingProxy",
    version: "1",
    chainId,
    verifyingContract: sellerContract,
  };
  const types = {
    SellerDelegation: [
      { name: "peerAddress", type: "address" },
      { name: "sellerContract", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ],
  };
  const message = { peerAddress, sellerContract, chainId, expiresAt };
  const signature = await operator.signTypedData(domain, types, message);
  return { signature };
}

function buildMetadata(
  peerId: PeerId,
  peerAddress: string,
  sellerContract: string,
  chainId: number,
  expiresAt: number,
  signature: string,
): PeerMetadata {
  return {
    peerId,
    version: 8,
    providers: [],
    region: "us-east-1",
    timestamp: Date.now(),
    sellerDelegation: {
      peerAddress: peerAddress.replace(/^0x/, ""),
      sellerContract: sellerContract.replace(/^0x/, ""),
      chainId,
      expiresAt,
      signature: signature.replace(/^0x/, ""),
    },
    signature: "",
  };
}

describe("SellerAddressResolver", () => {
  const operator = Wallet.createRandom();
  const peerWallet = Wallet.createRandom();
  const peerId = toPeerId(peerWallet.address.slice(2).toLowerCase());
  const peerAddress = peerWallet.address; // 0x-prefixed
  const sellerContract = PROXY;
  const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

  it("returns peerIdToAddress when no delegation", async () => {
    const resolver = new SellerAddressResolver({
      loadOperator: vi.fn().mockResolvedValue(operator.address),
      chainId: CHAIN_ID,
    });
    const result = await resolver.resolveSellerAddress(peerId, undefined);
    expect(result.toLowerCase()).toBe(("0x" + peerId).toLowerCase());
  });

  it("returns sellerContract when delegation valid (cached after first hit)", async () => {
    const { signature } = await buildSignedDelegation(operator, peerAddress, futureExpiry);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, CHAIN_ID, futureExpiry, signature);
    const mockLoader = vi.fn().mockResolvedValue(operator.address);
    const resolver = new SellerAddressResolver({ loadOperator: mockLoader, chainId: CHAIN_ID });

    const result1 = await resolver.resolveSellerAddress(peerId, metadata);
    expect(result1.toLowerCase()).toBe(sellerContract.toLowerCase());
    expect(mockLoader).toHaveBeenCalledTimes(1);

    // Second call should use cache — loader not called again
    const result2 = await resolver.resolveSellerAddress(peerId, metadata);
    expect(result2.toLowerCase()).toBe(sellerContract.toLowerCase());
    expect(mockLoader).toHaveBeenCalledTimes(1);
  });

  it("throws on expired delegation", async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 1;
    const { signature } = await buildSignedDelegation(operator, peerAddress, pastExpiry);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, CHAIN_ID, pastExpiry, signature);
    const resolver = new SellerAddressResolver({
      loadOperator: vi.fn().mockResolvedValue(operator.address),
      chainId: CHAIN_ID,
    });

    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerDelegationVerificationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow("expired");
  });

  it("throws on wrong chainId", async () => {
    const wrongChainId = 1; // mainnet, not base
    const { signature } = await buildSignedDelegation(operator, peerAddress, futureExpiry, sellerContract, wrongChainId);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, wrongChainId, futureExpiry, signature);
    const resolver = new SellerAddressResolver({
      loadOperator: vi.fn().mockResolvedValue(operator.address),
      chainId: CHAIN_ID,
    });

    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerDelegationVerificationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow("chainId mismatch");
  });

  it("throws on peerAddress != peerId", async () => {
    const differentWallet = Wallet.createRandom();
    const differentAddress = differentWallet.address;
    const { signature } = await buildSignedDelegation(operator, differentAddress, futureExpiry);
    // Metadata has different peerAddress than the peerId we're resolving
    const metadata = buildMetadata(peerId, differentAddress, sellerContract, CHAIN_ID, futureExpiry, signature);
    const resolver = new SellerAddressResolver({
      loadOperator: vi.fn().mockResolvedValue(operator.address),
      chainId: CHAIN_ID,
    });

    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerDelegationVerificationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      "peerAddress does not match peerId",
    );
  });

  it("throws when signature doesn't match current operator", async () => {
    const wrongOperator = Wallet.createRandom(); // signed by wrong operator
    const { signature } = await buildSignedDelegation(wrongOperator, peerAddress, futureExpiry);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, CHAIN_ID, futureExpiry, signature);

    // loader returns the *real* operator address, but signature was made by wrongOperator
    const resolver = new SellerAddressResolver({
      loadOperator: vi.fn().mockResolvedValue(operator.address),
      chainId: CHAIN_ID,
    });

    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerDelegationVerificationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      "signature does not match current operator",
    );
  });

  it("cache expires after TTL and re-reads operator", async () => {
    const { signature } = await buildSignedDelegation(operator, peerAddress, futureExpiry);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, CHAIN_ID, futureExpiry, signature);
    const mockLoader = vi.fn().mockResolvedValue(operator.address);
    const resolver = new SellerAddressResolver({
      loadOperator: mockLoader,
      chainId: CHAIN_ID,
      ttlMs: 0, // TTL of 0 means always expired
    });

    await resolver.resolveSellerAddress(peerId, metadata);
    await resolver.resolveSellerAddress(peerId, metadata);

    // With TTL=0, each call should re-read operator
    expect(mockLoader).toHaveBeenCalledTimes(2);
  });

  it("invalidate clears cache for a peer", async () => {
    const { signature } = await buildSignedDelegation(operator, peerAddress, futureExpiry);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, CHAIN_ID, futureExpiry, signature);
    const mockLoader = vi.fn().mockResolvedValue(operator.address);
    const resolver = new SellerAddressResolver({ loadOperator: mockLoader, chainId: CHAIN_ID });

    // First call — loads operator
    await resolver.resolveSellerAddress(peerId, metadata);
    expect(mockLoader).toHaveBeenCalledTimes(1);

    // Invalidate — should force re-verification
    resolver.invalidate(peerId);

    // Second call — cache was cleared, should load operator again
    await resolver.resolveSellerAddress(peerId, metadata);
    expect(mockLoader).toHaveBeenCalledTimes(2);
  });

  it("after operator rotation (mock loader returns new addr), old delegation with old signer throws", async () => {
    // Sign with original operator
    const { signature } = await buildSignedDelegation(operator, peerAddress, futureExpiry);
    const metadata = buildMetadata(peerId, peerAddress, sellerContract, CHAIN_ID, futureExpiry, signature);

    const newOperator = Wallet.createRandom();
    // Loader now returns the NEW operator (rotation happened)
    const mockLoader = vi.fn().mockResolvedValue(newOperator.address);
    const resolver = new SellerAddressResolver({
      loadOperator: mockLoader,
      chainId: CHAIN_ID,
      ttlMs: 0, // bypass cache so it re-reads operator
    });

    // Old delegation (signed by old operator) no longer matches the new operator
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerDelegationVerificationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      "signature does not match current operator",
    );
  });
});
