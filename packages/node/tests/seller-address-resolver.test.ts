import { describe, it, expect, vi } from "vitest";
import { Wallet } from "ethers";
import { SellerAddressResolver, SellerAuthorizationError } from "../src/discovery/seller-address-resolver.js";
import type { PeerMetadata } from "../src/discovery/peer-metadata.js";
import type { PeerId } from "../src/types/peer.js";
import { toPeerId } from "../src/types/peer.js";

const PROXY = "0x" + "ab".repeat(20);

function buildMetadata(peerId: PeerId, sellerContract: string = PROXY): PeerMetadata {
  return {
    peerId,
    version: 8,
    providers: [],
    region: "us-east-1",
    timestamp: Date.now(),
    sellerContract: sellerContract.replace(/^0x/, "").toLowerCase(),
    signature: "",
  };
}

describe("SellerAddressResolver", () => {
  const peerWallet = Wallet.createRandom();
  const peerId = toPeerId(peerWallet.address.slice(2).toLowerCase());

  it("returns peerIdToAddress when no sellerContract in metadata", async () => {
    const resolver = new SellerAddressResolver({
      isOperator: vi.fn().mockResolvedValue(true),
    });
    const result = await resolver.resolveSellerAddress(peerId, undefined);
    expect(result.toLowerCase()).toBe(("0x" + peerId).toLowerCase());
  });

  it("returns sellerContract when chain says peer is an authorized operator (cached after first hit)", async () => {
    const metadata = buildMetadata(peerId);
    const mockIsOperator = vi.fn().mockResolvedValue(true);
    const resolver = new SellerAddressResolver({ isOperator: mockIsOperator });

    const result1 = await resolver.resolveSellerAddress(peerId, metadata);
    expect(result1.toLowerCase()).toBe(PROXY.toLowerCase());
    expect(mockIsOperator).toHaveBeenCalledTimes(1);

    const result2 = await resolver.resolveSellerAddress(peerId, metadata);
    expect(result2.toLowerCase()).toBe(PROXY.toLowerCase());
    expect(mockIsOperator).toHaveBeenCalledTimes(1);
  });

  it("throws when chain says peer is NOT an operator", async () => {
    const metadata = buildMetadata(peerId);
    const resolver = new SellerAddressResolver({
      isOperator: vi.fn().mockResolvedValue(false),
    });

    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerAuthorizationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      "not an authorized operator",
    );
  });

  it("throws when the isOperator RPC call fails", async () => {
    const metadata = buildMetadata(peerId);
    const resolver = new SellerAddressResolver({
      isOperator: vi.fn().mockRejectedValue(new Error("network down")),
    });

    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      SellerAuthorizationError,
    );
    await expect(resolver.resolveSellerAddress(peerId, metadata)).rejects.toThrow(
      "isOperator RPC failed",
    );
  });

  it("cache expires after TTL and re-reads operator", async () => {
    const metadata = buildMetadata(peerId);
    const mockIsOperator = vi.fn().mockResolvedValue(true);
    const resolver = new SellerAddressResolver({
      isOperator: mockIsOperator,
      ttlMs: 0,
    });

    await resolver.resolveSellerAddress(peerId, metadata);
    await resolver.resolveSellerAddress(peerId, metadata);

    expect(mockIsOperator).toHaveBeenCalledTimes(2);
  });

  it("invalidate clears cache for a peer", async () => {
    const metadata = buildMetadata(peerId);
    const mockIsOperator = vi.fn().mockResolvedValue(true);
    const resolver = new SellerAddressResolver({ isOperator: mockIsOperator });

    await resolver.resolveSellerAddress(peerId, metadata);
    expect(mockIsOperator).toHaveBeenCalledTimes(1);

    resolver.invalidate(peerId);

    await resolver.resolveSellerAddress(peerId, metadata);
    expect(mockIsOperator).toHaveBeenCalledTimes(2);
  });

  it("re-verifies when sellerContract in metadata changes (different contract, cache entry bound to contract)", async () => {
    const OTHER_PROXY = "0x" + "cd".repeat(20);
    const mockIsOperator = vi.fn().mockResolvedValue(true);
    const resolver = new SellerAddressResolver({ isOperator: mockIsOperator });

    await resolver.resolveSellerAddress(peerId, buildMetadata(peerId, PROXY));
    expect(mockIsOperator).toHaveBeenCalledTimes(1);

    // Metadata now points at a different sellerContract — cache should not apply.
    await resolver.resolveSellerAddress(peerId, buildMetadata(peerId, OTHER_PROXY));
    expect(mockIsOperator).toHaveBeenCalledTimes(2);
  });
});
