// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBlockhashSource } from "../interfaces/IBlockhashSource.sol";

/**
 * @title AntseedBlockhashKeeper
 * @notice Permissionless archive of canonical block hashes. The EVM only
 *         exposes the most recent 256 block hashes via `blockhash`; anyone
 *         may checkpoint a recent hash here so proofs anchored to it can be
 *         verified after the native window has passed.
 *
 *         There is no owner and no way to write a hash the chain did not
 *         report: `checkpoint` reads `blockhash` directly, so a stored value
 *         is exactly as canonical as the chain's own record.
 */
contract AntseedBlockhashKeeper is IBlockhashSource {
    mapping(uint256 => bytes32) private _hashes;

    event Checkpointed(uint256 indexed number, bytes32 blockHash);

    error BlockhashUnavailable(uint256 number);

    /// @notice Store the canonical hash of `number`. Must be called within
    ///         the native 256-block window of that block.
    function checkpoint(uint256 number) public {
        bytes32 h = blockhash(number);
        if (h == bytes32(0)) revert BlockhashUnavailable(number);
        if (_hashes[number] == bytes32(0)) {
            _hashes[number] = h;
            emit Checkpointed(number, h);
        }
    }

    /// @notice Convenience: checkpoint the most recent block.
    function checkpointLatest() external {
        checkpoint(block.number - 1);
    }

    /// @inheritdoc IBlockhashSource
    function blockHash(uint256 number) external view returns (bytes32) {
        bytes32 stored = _hashes[number];
        if (stored != bytes32(0)) return stored;
        return blockhash(number);
    }
}
