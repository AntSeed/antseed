// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

library WashPenaltyMath {
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    // Placeholder calibration. Production activation scripts reject this
    // configuration until the detection AIP finalizes the curve and threshold.
    bool internal constant CONFIGURATION_FINALIZED = false;
    uint16 internal constant THETA_BPS = 5_000;

    function retainedBps(uint16 washRatioBps) internal pure returns (uint16) {
        if (washRatioBps == 0) return BPS_DENOMINATOR;
        if (washRatioBps >= THETA_BPS) return 0;

        uint256 remaining = uint256(THETA_BPS - washRatioBps);
        return uint16(Math.mulDiv(remaining * remaining, BPS_DENOMINATOR, uint256(THETA_BPS) * THETA_BPS));
    }

    function configurationFinalized() internal pure returns (bool) {
        return CONFIGURATION_FINALIZED;
    }

    function thetaBps() internal pure returns (uint16) {
        return THETA_BPS;
    }
}
