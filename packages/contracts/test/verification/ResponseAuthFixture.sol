// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { CommonBase } from "forge-std/Base.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";

/// @dev Test-side mirror of the FROZEN ResponseAuth signing scheme:
///        - packages/node/src/verification/response-auth.ts
///          (`buildResponseAuthSigningBytes`): 13 UTF-8 fields, each prefixed
///          with a 4-byte big-endian uint32 byte length;
///        - packages/node/src/p2p/identity.ts (`signData`): EIP-191
///          personal-sign over ("antseed-data-v1:" || signingBytes).
///      Peer ids render as lowercase 40-nibble hex WITHOUT a 0x prefix
///      (normalizePeerId strips it); request/response hashes render as
///      0x-prefixed 64-nibble hex (ethers keccak256 output). The
///      byte-identity of this builder with the TypeScript side is pinned in
///      AntseedVerifierAnchoring.t.sol
///      (test_pinnedCrossLanguageSigningPayload).
abstract contract ResponseAuthFixture is CommonBase {
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";

    struct ResponseAuthFields {
        string requestId;
        string channelId;
        address buyer;
        address seller;
        string advertisedService;
        string provider;
        uint256 statusCode;
        bytes32 requestHash;
        bytes32 responseHash;
        uint256 responseStartedAt;
        uint256 responseCompletedAt;
    }

    /// @dev The exact signing preimage the seller signs (and the contract
    ///      parses): 13 length-prefixed UTF-8 fields. Built through a fields
    ///      array + fold — a single 13-argument bytes.concat keeps too many
    ///      live memory pointers on the stack once callers inline this under
    ///      via-ir ("stack too deep" in Yul).
    function buildSigningPayload(ResponseAuthFields memory f) internal pure returns (bytes memory out) {
        bytes[] memory fields = new bytes[](13);
        fields[0] = "antseed-response-auth-v1";
        fields[1] = "1";
        fields[2] = bytes(f.requestId);
        fields[3] = bytes(f.channelId);
        fields[4] = _addressHex(f.buyer);
        fields[5] = _addressHex(f.seller);
        fields[6] = bytes(f.advertisedService);
        fields[7] = bytes(f.provider);
        fields[8] = bytes(Strings.toString(f.statusCode));
        fields[9] = _bytes32Hex(f.requestHash);
        fields[10] = _bytes32Hex(f.responseHash);
        fields[11] = bytes(Strings.toString(f.responseStartedAt));
        fields[12] = bytes(Strings.toString(f.responseCompletedAt));
        for (uint256 i = 0; i < fields.length; i++) {
            out = bytes.concat(out, _lp(fields[i]));
        }
    }

    /// @dev EIP-191 digest of ("antseed-data-v1:" || payload) — mirror of
    ///      AntseedVerifierRegistry.responseAuthDigest for memory bytes.
    function signingDigest(bytes memory payload) internal pure returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(bytes.concat(bytes("antseed-data-v1:"), payload));
    }

    /// @dev Real secp256k1 signature (r ‖ s ‖ v) over the payload's digest.
    function signResponseAuth(uint256 sellerKey, bytes memory payload) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, signingDigest(payload));
        return abi.encodePacked(r, s, v);
    }

    /// @dev One fully signed exchange record with realistic field sizes
    ///      (~420-byte signing payload). `salt` derives the request id and
    ///      both content hashes, so distinct salts give distinct leaves.
    function makeSignedRecord(uint256 agentId, uint256 sellerKey, address buyer, bytes32 salt)
        internal
        pure
        returns (IAntseedVerifierRegistry.ExchangeRecord memory record, bytes memory payload)
    {
        return makeSignedRecordForService(agentId, sellerKey, buyer, salt, "anthropic/claude-opus-4");
    }

    function makeSignedRecordForService(
        uint256 agentId,
        uint256 sellerKey,
        address buyer,
        bytes32 salt,
        string memory advertisedService
    ) internal pure returns (IAntseedVerifierRegistry.ExchangeRecord memory record, bytes memory payload) {
        bytes32 requestHash = keccak256(abi.encode("request", salt));
        bytes32 responseHash = keccak256(abi.encode("response", salt));
        payload = buildSigningPayload(
            ResponseAuthFields({
                requestId: string.concat("req-", vm.toString(salt)),
                channelId: "",
                buyer: buyer,
                seller: vm.addr(sellerKey),
                advertisedService: advertisedService,
                provider: "claude-oauth",
                statusCode: 200,
                requestHash: requestHash,
                responseHash: responseHash,
                responseStartedAt: 1_752_444_000_000,
                responseCompletedAt: 1_752_444_001_500
            })
        );
        record = IAntseedVerifierRegistry.ExchangeRecord({
            agentId: agentId,
            requestHash: requestHash,
            responseHash: responseHash,
            responseAuthSig: signResponseAuth(sellerKey, payload)
        });
    }

    /// @dev A batch of `n` signed records for one (agentId, sellerKey) pair,
    ///      all carried by `buyer`, with one probe declared per record.
    function makeSignedBatch(uint256 n, uint256 agentId, uint256 sellerKey, address buyer, bytes32 salt)
        internal
        pure
        returns (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory probeCounts
        )
    {
        records = new IAntseedVerifierRegistry.ExchangeRecord[](n);
        payloads = new bytes[](n);
        probeCounts = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            (records[i], payloads[i]) = makeSignedRecord(agentId, sellerKey, buyer, keccak256(abi.encode(salt, i)));
            probeCounts[i] = 1;
        }
    }

    function _lp(bytes memory field) private pure returns (bytes memory) {
        return abi.encodePacked(uint32(field.length), field);
    }

    /// @dev Lowercase hex, 40 nibbles, NO 0x prefix — normalizePeerId form.
    function _addressHex(address a) internal pure returns (bytes memory out) {
        out = new bytes(40);
        uint160 v = uint160(a);
        for (uint256 i = 40; i > 0; i--) {
            out[i - 1] = HEX_DIGITS[v & 0xf];
            v >>= 4;
        }
    }

    /// @dev Lowercase hex, 64 nibbles, 0x-prefixed — ethers keccak256 form.
    function _bytes32Hex(bytes32 h) internal pure returns (bytes memory out) {
        out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        uint256 v = uint256(h);
        for (uint256 i = 66; i > 2; i--) {
            out[i - 1] = HEX_DIGITS[v & 0xf];
            v >>= 4;
        }
    }
}
