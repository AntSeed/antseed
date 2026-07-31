// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";

abstract contract ResponseAuthFixture is Test {
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";

    function _signedResponseAuth(
        AntseedVerifierRegistry verifierRegistry,
        uint256 sellerKey,
        address buyer,
        address seller,
        string memory service,
        uint256 statusCode,
        bytes32 requestHash,
        uint64 startedAt,
        uint64 completedAt
    ) internal returns (bytes memory) {
        bytes[] memory fields = new bytes[](13);
        fields[0] = "antseed-response-auth-v1";
        fields[1] = "1";
        fields[2] = "request-id";
        fields[3] = "channel-id";
        fields[4] = _addressHex(buyer);
        fields[5] = _addressHex(seller);
        fields[6] = bytes(service);
        fields[7] = "provider";
        fields[8] = bytes(Strings.toString(statusCode));
        fields[9] = _bytes32Hex(requestHash);
        fields[10] = _bytes32Hex(keccak256(abi.encode(requestHash, "response")));
        fields[11] = bytes(Strings.toString(startedAt));
        fields[12] = bytes(Strings.toString(completedAt));

        bytes memory payload;
        for (uint256 i = 0; i < fields.length; i++) {
            payload = bytes.concat(payload, _lp(fields[i]));
        }
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, verifierRegistry.responseAuthDigest(payload));
        return abi.encodePacked(payload, r, s, v);
    }

    function _lp(bytes memory field) private pure returns (bytes memory) {
        return abi.encodePacked(uint32(field.length), field);
    }

    function _addressHex(address account) private pure returns (bytes memory out) {
        out = new bytes(40);
        uint160 value = uint160(account);
        for (uint256 i = 40; i > 0; i--) {
            out[i - 1] = HEX_DIGITS[value & 0xf];
            value >>= 4;
        }
    }

    function _bytes32Hex(bytes32 hash) private pure returns (bytes memory out) {
        out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        uint256 value = uint256(hash);
        for (uint256 i = 66; i > 2; i--) {
            out[i - 1] = HEX_DIGITS[value & 0xf];
            value >>= 4;
        }
    }
}
